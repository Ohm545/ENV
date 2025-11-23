import express from "express";
import axios from "axios";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import os from "os";
import streamifier from "streamifier";
import cloudinary from "cloudinary";
import sizeOf from "image-size";
import ffmpeg from "fluent-ffmpeg";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { GoogleGenerativeAI } from "@google/generative-ai";
// ES module fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
puppeteer.use(StealthPlugin());

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// FIXED: Enhanced multer configuration for better file handling
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
    files: 10 // Maximum 10 files
  },
  fileFilter: (req, file, cb) => {
    // Accept all file types
    console.log(`📁 File received: ${file.originalname}, Type: ${file.mimetype}, Size: ${file.size} bytes`);
    cb(null, true);
  }
});

const homeserver = process.env.MATRIX_HOMESERVER_URL;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const activeSessions = new Map();
const userSocketMap = new Map();
const userSyncLoops = new Map();

// NEW: Platform status tracking
const platformStatus = new Map();

// Direct access token (replace with your actual token)
const DIRECT_ACCESS_TOKEN = "";

// FIXED: Enhanced Media URL Resolution Functions with proper homeserver URL
function resolveMxcUrl(mxcUrl) {
  if (!mxcUrl || !mxcUrl.startsWith('mxc://')) {
    return mxcUrl; // Return as-is if not MXC URL
  }
  
  // Extract server and media ID from mxc:// URL
  const parts = mxcUrl.replace('mxc://', '').split('/');
  if (parts.length !== 2) {
    return mxcUrl; // Invalid format
  }
  
  const [server, mediaId] = parts;
  
  // Return the downloadable URL with proper homeserver URL
  return `${homeserver}/_matrix/media/v3/download/${server}/${mediaId}`;
}
// Enhanced function to get thumbnail URLs for images/videos
function getThumbnailUrl(mxcUrl, width = 800, height = 600, method = 'scale') {
  if (!mxcUrl || !mxcUrl.startsWith('mxc://')) {
    return mxcUrl;
  }
  
  const parts = mxcUrl.replace('mxc://', '').split('/');
  if (parts.length !== 2) {
    return mxcUrl;
  }
  
  const [server, mediaId] = parts;
  
  return `${homeserver}/_matrix/media/v3/thumbnail/${server}/${mediaId}?width=${width}&height=${height}&method=${method}`;
}

// Serve the main frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve other frontend routes (for SPA)
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// NEW: Platform status management
function updatePlatformStatus(platform, connected, userEmail = null) {
  const key = userEmail ? `${userEmail}_${platform}` : platform;
  platformStatus.set(key, {
    connected,
    lastUpdated: Date.now(),
    userEmail
  });
  
  // Notify connected sockets
  if (userEmail) {
    const socketId = userSocketMap.get(userEmail);
    if (socketId) {
      io.to(socketId).emit('platform_status', {
        platform,
        connected,
        userEmail
      });
    }
  }
}

function getPlatformStatus(platform, userEmail = null) {
  const key = userEmail ? `${userEmail}_${platform}` : platform;
  return platformStatus.get(key) || { connected: false, lastUpdated: null };
}

async function ensureDirectRoom(userId, botUserId, accessToken) {
  try {
    console.log(`🔍 Looking for existing direct room with ${botUserId}...`);
    
    // Get all joined rooms
    const roomsResponse = await axios.get(`${homeserver}/_matrix/client/v3/joined_rooms`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    const roomIds = roomsResponse.data.joined_rooms || [];
    console.log(`📋 User is in ${roomIds.length} rooms`);
    
    // Look for existing direct message with the bot
    for (const roomId of roomIds) {
      try {
        const membersResponse = await axios.get(
          `${homeserver}/_matrix/client/v3/rooms/${roomId}/joined_members`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        
        const members = Object.keys(membersResponse.data.joined || {});
        
        // Check if this is a direct chat with exactly 2 members (user + bot)
        if (members.length === 2 && 
            members.includes(userId) && 
            members.includes(botUserId)) {
          console.log(`✅ Found existing direct room: ${roomId}`);
          console.log(`👥 Members: ${members.join(', ')}`);
          return roomId;
        }
      } catch (roomError) {
        console.warn(`⚠️ Could not check room ${roomId}:`, roomError.message);
        continue;
      }
    }
    
    // If no existing room found, create a new one
    console.log(`🆕 No existing room found, creating new direct room with ${botUserId}...`);
    
    const createRoomResponse = await axios.post(
      `${homeserver}/_matrix/client/v3/createRoom`,
      {
        preset: "trusted_private_chat",
        is_direct: true,
        invite: [botUserId],
        name: `WhatsApp Bridge`, // Simple, consistent name
        topic: "WhatsApp bridge connection"
      },
      { 
        headers: { 
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const roomId = createRoomResponse.data.room_id;
    console.log(`✅ Created new direct room: ${roomId}`);
    
    return roomId;
    
  } catch (error) {
    console.error("❌ Error ensuring direct room:", error.response?.data || error.message);
    throw error;
  }
}
async function loginTelegram(userEmail, phoneNumber) {
  try {
    const botUserId = "@telegrambot:matrix.localhost";
    const matrix_access_token = DIRECT_ACCESS_TOKEN;
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    const roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);

    // Step 1: Send login command first
    console.log("Starting Telegram login...");
    
    await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
      { 
        msgtype: "m.text", 
        body: "login"
      },
      { headers: { Authorization: `Bearer ${matrix_access_token}` } }
    );

    console.log("Telegram login command sent. Waiting for phone number request...");

    let attempts = 0;
    const maxAttempts = 10;
    
    // Step 2: Wait for bot to ask for phone number
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempts++;
      
      console.log(`Polling attempt ${attempts}/${maxAttempts}...`);
      
      const pollRes = await axios.get(
        `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=30`,
        { headers: { Authorization: `Bearer ${matrix_access_token}` } }
      );

      const events = pollRes.data.chunk || [];
      
      for (const ev of events) {
        if (ev.sender === botUserId && ev.content?.body) {
          const body = ev.content.body;
          console.log("Telegram Bot:", body);
          
          // Check if bot is asking for phone number
          if (body.includes("phone") || body.includes("number") || body.includes("+")) {
            console.log("📱 Telegram requesting phone number");
            
            if (phoneNumber) {
              console.log("Sending phone number to Telegram bot...");
              await axios.put(
                `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now() + 1}`,
                { 
                  msgtype: "m.text", 
                  body: phoneNumber
                },
                { headers: { Authorization: `Bearer ${matrix_access_token}` } }
              );

              console.log("Phone number sent. Waiting for verification code request...");
              
              // Wait for verification code request
              let codeAttempts = 0;
              const maxCodeAttempts = 10;
              
              while (codeAttempts < maxCodeAttempts) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                codeAttempts++;
                
                console.log(`Waiting for code request... Attempt ${codeAttempts}/${maxCodeAttempts}`);
                
                const codeRes = await axios.get(
                  `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=20`,
                  { headers: { Authorization: `Bearer ${matrix_access_token}` } }
                );

                const codeEvents = codeRes.data.chunk || [];
                
                for (const codeEv of codeEvents) {
                  if (codeEv.sender === botUserId && codeEv.content?.body) {
                    const codeBody = codeEv.content.body;
                    console.log("Bot response after phone:", codeBody);
                    
                    if (codeBody.includes("code") || codeBody.includes("verification") || codeBody.includes("sent to")) {
                      // Create session for verification
                      const sessionId = uuidv4();
                      activeSessions.set(sessionId, {
                        userEmail,
                        roomId,
                        matrix_access_token,
                        phoneNumber,
                        timestamp: Date.now()
                      });
                      
                      return { 
                        success: true, 
                        type: "code_request",
                        content: codeBody,
                        roomId,
                        sessionId,
                        message: "Verification code sent to your Telegram"
                      };
                    }
                  }
                }
              }
              
              return { 
                success: false, 
                message: "No verification code request received after sending phone number" 
              };
            } else {
              return { 
                success: true, 
                type: "phone_request",
                content: body,
                roomId,
                message: "Telegram is requesting your phone number"
              };
            }
          }
        }
      }
    }

    return { 
      success: false, 
      message: "No response from Telegram bridge" 
    };

  } catch (error) {
    console.error("Telegram login error:", error.response?.data || error.message);
    throw error;
  }
}

async function verifyTelegramCode(sessionId, code) {
  try {
    console.log("Verifying Telegram code with session:", sessionId);
    console.log("Active sessions:", Array.from(activeSessions.keys()));
    
    const session = activeSessions.get(sessionId);
    if (!session) {
      console.error("Session not found for ID:", sessionId);
      throw new Error("Invalid session. Please restart the Telegram login process.");
    }
    
    const { roomId, matrix_access_token, userEmail } = session;
    
    console.log("Sending verification code to Telegram bot...");
    
    await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
      { msgtype: "m.text", body: code },
      { headers: { Authorization: `Bearer ${matrix_access_token}` } }
    );
    
    console.log("Verification code sent. Waiting for login confirmation...");
    
    // Wait for success message
    let attempts = 0;
    const maxAttempts = 15;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempts++;
      
      console.log(`Checking for login confirmation... Attempt ${attempts}/${maxAttempts}`);
      
      const pollRes = await axios.get(
        `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=10`,
        { headers: { Authorization: `Bearer ${matrix_access_token}` } }
      );

      const events = pollRes.data.chunk || [];
      
      for (const ev of events) {
        if (ev.sender === "@telegrambot:matrix.localhost" && ev.content?.body) {
          const body = ev.content.body;
          console.log("Bot response after code:", body);
          
          if (body.includes("success") || body.includes("logged in") || body.includes("connected") || body.includes("You are logged in")) {
            // Clean up session
            activeSessions.delete(sessionId);
            // Update platform status
            updatePlatformStatus('telegram', true, userEmail);
            
            return { 
              success: true, 
              message: "Telegram login successful!"
            };
          }
          
          if (body.includes("invalid") || body.includes("wrong") || body.includes("error")) {
            return { 
              success: false, 
              message: body
            };
          }
        }
      }
    }
    
    // If we get here, we didn't get a clear success message but the code was sent
    updatePlatformStatus('telegram', true, userEmail);
    return { 
      success: true, 
      message: "Code sent successfully. Please check if you're logged in." 
    };
  } catch (error) {
    console.error("Telegram verification error:", error);
    throw error;
  }
}

// REPLACE your aggregateReactions function with this:
function aggregateReactions(events) {
    const reactionsMap = new Map();
    
    console.log(`🔍 Processing ${events.length} events for reactions`);
    
    events.forEach(event => {
        if (event.type === 'm.reaction') {
            const relatesTo = event.content['m.relates_to'];
            console.log('📌 Reaction event found:', relatesTo);
            
            if (relatesTo && relatesTo.rel_type === 'm.annotation') {
                const emoji = relatesTo.key;
                const messageId = relatesTo.event_id;
                
                console.log(`🎯 Aggregating reaction: ${emoji} for message ${messageId}`);
                
                if (!reactionsMap.has(messageId)) {
                    reactionsMap.set(messageId, new Map());
                }
                
                const messageReactions = reactionsMap.get(messageId);
                if (!messageReactions.has(emoji)) {
                    messageReactions.set(emoji, {
                        emoji: emoji,
                        count: 0,
                        senders: []
                    });
                }
                
                const reaction = messageReactions.get(emoji);
                reaction.count++;
                reaction.senders.push(event.sender);
                
                console.log(`✅ Reaction ${emoji} now has ${reaction.count} reactions from ${reaction.senders.length} senders`);
            }
        }
    });
    
    // Convert to the format expected by frontend
    const aggregated = {};
    reactionsMap.forEach((emojiMap, messageId) => {
        aggregated[messageId] = Array.from(emojiMap.values());
        console.log(`📦 Message ${messageId} has ${aggregated[messageId].length} reaction types`);
    });
    
    console.log(`🎉 Final aggregation: ${Object.keys(aggregated).length} messages with reactions`);
    return aggregated;
}

async function loginInstagram(userEmail) {
  let browser;
  try {
    console.log("🚀 Starting Instagram login process...");
    
    browser = await puppeteer.launch({
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--window-size=1280,720"
      ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log("🌐 Navigating to Instagram...");
    await page.goto("https://www.instagram.com/accounts/login/", { 
      waitUntil: "networkidle2",
      timeout: 60000
    });
    
    console.log("⏳ Waiting for manual login...");
    console.log("📝 Please complete Instagram login manually in the browser window...");
    
    // Wait for login completion - better detection
    try {
      await Promise.race([
        page.waitForSelector('svg[aria-label="Home"]', { timeout: 300000 }), // 5 minutes
        page.waitForSelector('a[href="/"]', { timeout: 300000 }),
        page.waitForSelector('div[data-testid="nav-bar"]', { timeout: 300000 }),
        page.waitForFunction(
          () => {
            const currentUrl = window.location.href;
            return currentUrl.includes('instagram.com') && 
                   !currentUrl.includes('/accounts/login') && 
                   !currentUrl.includes('/accounts/emailsignup');
          },
          { timeout: 300000 }
        )
      ]);
    } catch (waitError) {
      const currentUrl = page.url();
      console.log(`📊 Current URL: ${currentUrl}`);
      
      if (currentUrl.includes('/accounts/login') || currentUrl.includes('/accounts/emailsignup')) {
        throw new Error("Instagram login failed or not completed within timeout");
      }
      // If we're on a different page, continue - maybe login was successful
    }
    
    // Additional check to confirm login
    try {
      await page.waitForSelector('input[placeholder="Search"]', { timeout: 10000 });
    } catch (e) {
      console.log("⚠️ Search bar not found, but continuing...");
    }
    
    console.log("✅ Login successful, extracting cookies...");
    
    // Get all cookies
    const cookies = await page.cookies();
    console.log(`🍪 Found ${cookies.length} cookies`);
    
    // Format cookies as simple JSON object
    const cookiesJson = {};
    cookies.forEach(cookie => {
      cookiesJson[cookie.name] = cookie.value;
    });
    
    console.log("📋 Cookie names:", Object.keys(cookiesJson));
    
    await browser.close();
    
    // Send to Meta bridge
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    const matrix_access_token = DIRECT_ACCESS_TOKEN;
    const botUserId = "@metabot:matrix.localhost";
    
    console.log("🤖 Connecting to Meta bridge...");
    const roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);
    
    // Step 1: Send login command first
    console.log("📤 Sending login command to Instagram bridge...");
    await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
      { 
        msgtype: "m.text", 
        body: "login"
      },
      { headers: { Authorization: `Bearer ${matrix_access_token}` } }
    );
    
    // Wait a moment for bridge to respond
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step 2: Send cookies as JSON string
    console.log("📤 Sending cookies JSON to Instagram bridge...");
    const cookiesString = JSON.stringify(cookiesJson);
    console.log(`📊 Cookies JSON length: ${cookiesString.length} characters`);
    
    await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now() + 1}`,
      { 
        msgtype: "m.text", 
        body: cookiesString
      },
      { headers: { Authorization: `Bearer ${matrix_access_token}` } }
    );
    
    console.log("✅ Cookies sent to Instagram bridge");
    
    // Wait for bridge response
    console.log("⏳ Waiting for bridge response...");
    let attempts = 0;
    const maxAttempts = 15;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempts++;
      
      const pollRes = await axios.get(
        `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=10`,
        { headers: { Authorization: `Bearer ${matrix_access_token}` } }
      );

      const events = pollRes.data.chunk || [];
      
      for (const ev of events.reverse()) {
        if (ev.sender === botUserId && ev.content?.body) {
          const body = ev.content.body;
          console.log(`🤖 Bridge response: ${body}`);
          
          if (body.includes("success") || body.includes("logged in") || body.includes("connected")) {
            updatePlatformStatus('instagram', true, userEmail);
            return { 
              success: true, 
              message: "Instagram login successful!",
              cookiesCount: Object.keys(cookiesJson).length
            };
          }
          
          if (body.includes("error") || body.includes("fail") || body.includes("invalid")) {
            return {
              success: false,
              message: `Instagram bridge error: ${body}`,
              cookiesCount: Object.keys(cookiesJson).length
            };
          }
        }
      }
    }
    
    // If no clear response but cookies were sent, assume success
    updatePlatformStatus('instagram', true, userEmail);
    return { 
      success: true, 
      message: "Instagram cookies sent successfully. Bridge is processing...",
      cookiesCount: Object.keys(cookiesJson).length
    };
    
  } catch (error) {
    console.error("❌ Instagram login error:", error.message);
    if (browser) {
      await browser.close();
    }
    return {
      success: false,
      message: `Instagram login failed: ${error.message}`
    };
  }
}

async function loginTwitter(userEmail) {
  let browser;
  try {
    const browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    
    const page = await browser.newPage();
    await page.goto("https://x.com/i/flow/login", { 
      waitUntil: "networkidle2" 
    });
    
    console.log("Please complete Twitter login manually...");
    
    // Wait for successful login
    await Promise.race([
      page.waitForSelector('a[href="/home"]', { timeout: 300000 }),
      page.waitForSelector('div[data-testid="AppTabBar_Home_Link"]', { timeout: 300000 }),
      page.waitForSelector('a[data-testid="AppTabBar_Home_Link"]', { timeout: 300000 })
    ]);
    
    console.log("Twitter login successful, extracting specific cookies...");
    
    const cookies = await page.cookies();
    const ct0Cookie = cookies.find(c => c.name === 'ct0');
    const authTokenCookie = cookies.find(c => c.name === 'auth_token');
    
    if (!ct0Cookie || !authTokenCookie) {
      throw new Error("Required cookies (ct0 or auth_token) not found");
    }
    
    await browser.close();
    
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    const matrix_access_token = DIRECT_ACCESS_TOKEN;
    const botUserId = "@twitterbot:matrix.localhost";
    
    const roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);
    
    // Step 1: Send login command first
    console.log("Sending login command to Twitter bridge...");
    await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
      { 
        msgtype: "m.text", 
        body: "login"
      },
      { headers: { Authorization: `Bearer ${matrix_access_token}` } }
    );
    
    // Wait a moment for bridge to respond
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 2: Send the cookies
    console.log("Sending cookies to Twitter bridge...");
    await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now() + 1}`,
      { 
        msgtype: "m.text", 
        body: JSON.stringify({
          ct0: ct0Cookie.value,
          auth_token: authTokenCookie.value
        })
      },
      { headers: { Authorization: `Bearer ${matrix_access_token}` } }
    );
    
    console.log("Twitter login process completed successfully");
    
    // Update platform status
    updatePlatformStatus('twitter', true, userEmail);
    
    return { 
      success: true,
      message: "Twitter login successful!"
    };
    
  } catch (error) {
    console.error("Twitter login error:", error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}
// FIXED: Enhanced uploadMedia function with proper error handling
async function uploadMedia(buffer, filename, mimetype, accessToken) {
  try {
    // Upload to Matrix media repository and return MXC URL
    const mxcUri = await uploadToMatrixMedia(buffer, filename, mimetype, accessToken);
    console.log(`✅ File uploaded to Matrix: ${mxcUri}`);
    return mxcUri; // Return the MXC URL
  } catch (uploadError) {
    console.error("❌ Matrix upload failed:", uploadError);
    
    // Fallback to Cloudinary if Matrix upload fails
    try {
      console.log("🔄 Trying Cloudinary upload as fallback...");
      const resourceType = mimetype.startsWith('image/') ? 'image' : 
                          mimetype.startsWith('video/') ? 'video' : 
                          mimetype.startsWith('audio/') ? 'raw' : 'auto';
      
      const cloudinaryUrl = await uploadToCloudinaryBuffer(buffer, resourceType, 'unified-messaging');
      console.log(`✅ File uploaded to Cloudinary: ${cloudinaryUrl}`);
      return cloudinaryUrl;
    } catch (cloudinaryError) {
      console.error("❌ Cloudinary upload also failed:", cloudinaryError);
      throw new Error(`Both Matrix and Cloudinary uploads failed: ${uploadError.message}`);
    }
  }
}

async function uploadToCloudinaryBuffer(buffer, resourceType, folder) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.v2.uploader.upload_stream(
      { 
        resource_type: resourceType, 
        folder,
        timeout: 60000 // 60 second timeout
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

async function uploadToMatrixMedia(buffer, filename, mimetype, accessToken) {
  const url = `${homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`;
  const response = await axios.post(url, buffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": mimetype,
    },
    timeout: 60000, // 60 second timeout
    maxContentLength: 50 * 1024 * 1024, // 50MB
  });
  return response.data.content_uri;
}

// FIXED: Enhanced file type detection
function getFileInfo(mimetype, filename) {
  let msgtype = "m.file";
  let info = { mimetype, size: 0 };
  
  if (mimetype.startsWith("image/")) {
    msgtype = "m.image";
  } else if (mimetype.startsWith("video/")) {
    msgtype = "m.video";
  } else if (mimetype.startsWith("audio/")) {
    msgtype = "m.audio";
  } else if (mimetype.includes('pdf')) {
    msgtype = "m.file";
  } else if (mimetype.includes('text')) {
    msgtype = "m.file";
  }
  
  return { msgtype, info };
}

async function probeVideoMetadata(tempPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(tempPath, (err, data) => {
      if (err) return reject(err);
      const format = data.format || {};
      const streams = data.streams || [];
      const videoStream = streams.find(s => s.codec_type === "video");
      const audioStream = streams.find(s => s.codec_type === "audio");
      const info = {};
      if (format.duration) info.duration = Math.round(format.duration * 1000);
      if (videoStream && videoStream.width) info.w = videoStream.width;
      if (videoStream && videoStream.height) info.h = videoStream.height;
      resolve(info);
    });
  });
}

// Improved WhatsApp Status Check
async function checkWhatsAppStatus(userEmail) {
  let roomId;
  try {
    const matrix_access_token = DIRECT_ACCESS_TOKEN;
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    const botUserId = "@whatsappbot:matrix.localhost";

    console.log("🔍 Checking WhatsApp status...");
    
    // Ensure we have a valid room
    roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);
    
    if (!roomId || !roomId.startsWith('!')) {
      throw new Error(`Invalid room ID: ${roomId}`);
    }
    
    // Send status check command
    const statusResponse = await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
      { 
        msgtype: "m.text", 
        body: "!wa list-logins"
      },
      { 
        headers: { 
          Authorization: `Bearer ${matrix_access_token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    console.log(`✅ Status check sent: ${statusResponse.data.event_id}`);

    // Wait for response with better error handling
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
      
      console.log(`📡 Polling for status (${attempts}/${maxAttempts})...`);
      
      try {
        const pollRes = await axios.get(
          `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=20`,
          { 
            headers: { Authorization: `Bearer ${matrix_access_token}` },
            timeout: 8000
          }
        );

        const events = pollRes.data.chunk || [];
        
        for (const ev of events.reverse()) {
          if (ev.sender === botUserId && ev.content?.body) {
            const body = ev.content.body;
            console.log(`🤖 WhatsApp Status: ${body.substring(0, 200)}`);
            
            // Check for connected status
            if (body.includes("CONNECTED") || body.includes("connected") || body.match(/\+\d+.*CONNECTED/)) {
              const phoneMatch = body.match(/(\+\d+|\d+)/);
              const phoneNumber = phoneMatch ? phoneMatch[0] : 'Unknown';
              
              updatePlatformStatus('whatsapp', true, userEmail);
              
              return {
                success: true,
                platform: 'whatsapp',
                status: 'connected',
                phoneNumber: phoneNumber,
                message: `WhatsApp is connected: ${phoneNumber}`,
                rawResponse: body
              };
            }
            
            // Check for disconnected status
            if (body.includes("No logins") || body.includes("no sessions") || body.includes("Not logged in") || body.includes("You're not logged in")) {
              updatePlatformStatus('whatsapp', false, userEmail);
              
              return {
                success: true,
                platform: 'whatsapp',
                status: 'disconnected',
                message: "WhatsApp is not connected",
                rawResponse: body
              };
            }
            
            // Check for bridge errors
            if (body.includes("error") || body.includes("failed") || body.includes("not running")) {
              return {
                success: false,
                platform: 'whatsapp',
                status: 'bridge_error',
                message: `WhatsApp bridge error: ${body}`,
                rawResponse: body
              };
            }
          }
        }
      } catch (pollError) {
        console.warn(`⚠️ Status polling attempt ${attempts} failed:`, pollError.message);
        // Continue to next attempt instead of breaking
      }
    }
    
    // If we get here, no clear status was received
    return {
      success: false,
      platform: 'whatsapp',
      status: 'timeout',
      message: "No response from WhatsApp bridge within timeout"
    };
    
  } catch (error) {
    console.error("❌ WhatsApp status check error:", error.message);
    
    // Handle specific error types
    let errorType = 'error';
    if (error.response?.status === 404) {
      errorType = 'room_not_found';
    } else if (error.code === 'ECONNREFUSED') {
      errorType = 'homeserver_unreachable';
    } else if (error.response?.status === 403) {
      errorType = 'access_denied';
    }
    
    return {
      success: false,
      platform: 'whatsapp',
      status: errorType,
      message: `WhatsApp status check failed: ${error.message}`,
      errorDetails: error.response?.data || error.code
    };
  }
}

// Improved Instagram Status Check
async function checkInstagramStatus(userEmail) {
  try {
    const matrix_access_token = DIRECT_ACCESS_TOKEN;
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    const botUserId = "@metabot:matrix.localhost";

    console.log("🔍 Checking Instagram status...");
    
    const roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);
    
    if (!roomId || !roomId.startsWith('!')) {
      throw new Error(`Invalid room ID: ${roomId}`);
    }
    
    // Try multiple status commands
    const statusCommands = ["status", "whoami", "info", "list-logins"];
    let lastError = null;
    
    for (const command of statusCommands) {
      try {
        console.log(`📤 Trying status command: ${command}`);
        
        await axios.put(
          `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
          { 
            msgtype: "m.text", 
            body: command
          },
          { 
            headers: { Authorization: `Bearer ${matrix_access_token}` },
            timeout: 10000
          }
        );

        // Wait for response
        let attempts = 0;
        const maxAttempts = 8;
        
        while (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
          
          const pollRes = await axios.get(
            `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=15`,
            { 
              headers: { Authorization: `Bearer ${matrix_access_token}` },
              timeout: 8000
            }
          );

          const events = pollRes.data.chunk || [];
          
          for (const ev of events.reverse()) {
            if (ev.sender === botUserId && ev.content?.body) {
              const body = ev.content.body;
              console.log(`🤖 Instagram Response: ${body.substring(0, 200)}`);
              
              // Check for connected status
              if (body.includes("logged in") || body.includes("connected") || body.includes("Logged in as") || body.match(/\+\d+.*CONNECTED/)) {
                const usernameMatch = body.match(/Logged in as (@\w+|\w+)/);
                const username = usernameMatch ? usernameMatch[1] : 'Unknown';
                const phoneMatch = body.match(/(\+\d+|\d+) - CONNECTED/);
                const phoneNumber = phoneMatch ? phoneMatch[1] : null;
                
                updatePlatformStatus('instagram', true, userEmail);
                
                return {
                  success: true,
                  platform: 'instagram',
                  status: 'connected',
                  username: username,
                  phoneNumber: phoneNumber,
                  message: phoneNumber ? `Instagram is connected: ${phoneNumber}` : `Instagram is connected: ${username}`,
                  rawResponse: body
                };
              }
              
              // Check for disconnected status
              if (body.includes("not logged in") || body.includes("You're not logged in") || body.includes("No active session")) {
                updatePlatformStatus('instagram', false, userEmail);
                
                return {
                  success: true,
                  platform: 'instagram',
                  status: 'disconnected',
                  message: "Instagram is not connected",
                  rawResponse: body
                };
              }
              
              // If we got a response but can't determine status, continue to next command
              if (body.length > 0 && !body.includes("error") && !body.includes("Unknown command")) {
                // This might be a valid response we don't understand
                console.log(`⚠️ Unrecognized Instagram response: ${body}`);
              }
            }
          }
        }
      } catch (cmdError) {
        lastError = cmdError;
        console.warn(`❌ Command '${command}' failed:`, cmdError.message);
        continue; // Try next command
      }
    }
    
    // If all commands failed
    return {
      success: false,
      platform: 'instagram',
      status: 'unknown',
      message: "Could not determine Instagram status with any command",
      lastError: lastError?.message
    };
    
  } catch (error) {
    console.error("❌ Instagram status check error:", error.message);
    return {
      success: false,
      platform: 'instagram',
      status: 'error',
      message: `Instagram status check failed: ${error.message}`
    };
  }
}

// Improved Twitter Status Check
async function checkTwitterStatus(userEmail) {
  try {
    const matrix_access_token = DIRECT_ACCESS_TOKEN;
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    const botUserId = "@twitterbot:matrix.localhost";

    console.log("🔍 Checking Twitter status...");
    
    const roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);
    
    if (!roomId || !roomId.startsWith('!')) {
      throw new Error(`Invalid room ID: ${roomId}`);
    }
    
    // Try multiple status commands
    const statusCommands = ["status", "whoami", "info"];
    let lastError = null;
    
    for (const command of statusCommands) {
      try {
        console.log(`📤 Trying status command: ${command}`);
        
        await axios.put(
          `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
          { 
            msgtype: "m.text", 
            body: command
          },
          { 
            headers: { Authorization: `Bearer ${matrix_access_token}` },
            timeout: 10000
          }
        );

        // Wait for response
        let attempts = 0;
        const maxAttempts = 8;
        
        while (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
          
          const pollRes = await axios.get(
            `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=15`,
            { 
              headers: { Authorization: `Bearer ${matrix_access_token}` },
              timeout: 8000
            }
          );

          const events = pollRes.data.chunk || [];
          
          for (const ev of events.reverse()) {
            if (ev.sender === botUserId && ev.content?.body) {
              const body = ev.content.body;
              console.log(`🤖 Twitter Response: ${body.substring(0, 200)}`);
              
              // Check for connected status
              if (body.includes("logged in") || body.includes("connected") || body.includes("Logged in as") || body.match(/\+\d+.*CONNECTED/)) {
                const usernameMatch = body.match(/Logged in as (@\w+|\w+)/);
                const username = usernameMatch ? usernameMatch[1] : 'Unknown';
                const phoneMatch = body.match(/(\+\d+|\d+) - CONNECTED/);
                const phoneNumber = phoneMatch ? phoneMatch[1] : null;
                
                updatePlatformStatus('twitter', true, userEmail);
                
                return {
                  success: true,
                  platform: 'twitter',
                  status: 'connected',
                  username: username,
                  phoneNumber: phoneNumber,
                  message: phoneNumber ? `Twitter is connected: ${phoneNumber}` : `Twitter is connected: ${username}`,
                  rawResponse: body
                };
              }
              
              // Check for disconnected status
              if (body.includes("not logged in") || body.includes("You're not logged in") || body.includes("No active session")) {
                updatePlatformStatus('twitter', false, userEmail);
                
                return {
                  success: true,
                  platform: 'twitter',
                  status: 'disconnected',
                  message: "Twitter is not connected",
                  rawResponse: body
                };
              }
            }
          }
        }
      } catch (cmdError) {
        lastError = cmdError;
        console.warn(`❌ Command '${command}' failed:`, cmdError.message);
        continue;
      }
    }
    
    return {
      success: false,
      platform: 'twitter',
      status: 'unknown',
      message: "Could not determine Twitter status",
      lastError: lastError?.message
    };
    
  } catch (error) {
    console.error("❌ Twitter status check error:", error.message);
    return {
      success: false,
      platform: 'twitter',
      status: 'error',
      message: `Twitter status check failed: ${error.message}`
    };
  }
}

// Improved Telegram Status Check
async function checkTelegramStatus(userEmail) {
  try {
    const matrix_access_token = DIRECT_ACCESS_TOKEN;
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    const botUserId = "@telegrambot:matrix.localhost";

    console.log("🔍 Checking Telegram status...");
    
    const roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);
    
    if (!roomId || !roomId.startsWith('!')) {
      throw new Error(`Invalid room ID: ${roomId}`);
    }
    
    // Try multiple commands to check status
    const statusCommands = ["sync", "status", "whoami"];
    let lastError = null;
    
    for (const command of statusCommands) {
      try {
        console.log(`📤 Trying Telegram command: ${command}`);
        
        await axios.put(
          `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
          { 
            msgtype: "m.text", 
            body: command
          },
          { 
            headers: { Authorization: `Bearer ${matrix_access_token}` },
            timeout: 10000
          }
        );

        // Wait for response
        let attempts = 0;
        const maxAttempts = 8;
        
        while (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
          
          const pollRes = await axios.get(
            `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=15`,
            { 
              headers: { Authorization: `Bearer ${matrix_access_token}` },
              timeout: 8000
            }
          );

          const events = pollRes.data.chunk || [];
          
          for (const ev of events.reverse()) {
            if (ev.sender === botUserId && ev.content?.body) {
              const body = ev.content.body;
              console.log(`🤖 Telegram Response: ${body.substring(0, 200)}`);
              
              // Check for connected status
              if ((body.includes("sync") && body.includes("started")) || 
                  body.includes("Syncing") || 
                  body.includes("logged in") || 
                  body.includes("connected")) {
                updatePlatformStatus('telegram', true, userEmail);
                
                return {
                  success: true,
                  platform: 'telegram',
                  status: 'connected',
                  message: "Telegram is connected",
                  rawResponse: body
                };
              }
              
              // Check for disconnected status
              if (body.includes("not logged in") || 
                  body.includes("You're not logged in") || 
                  body.includes("Login required") ||
                  body.includes("Please login first")) {
                updatePlatformStatus('telegram', false, userEmail);
                
                return {
                  success: true,
                  platform: 'telegram',
                  status: 'disconnected',
                  message: "Telegram is not connected - login required",
                  rawResponse: body
                };
              }
            }
          }
        }
      } catch (cmdError) {
        lastError = cmdError;
        console.warn(`❌ Telegram command '${command}' failed:`, cmdError.message);
        continue;
      }
    }
    
    return {
      success: false,
      platform: 'telegram',
      status: 'unknown',
      message: "Could not determine Telegram status",
      lastError: lastError?.message
    };
    
  } catch (error) {
    console.error("❌ Telegram status check error:", error.message);
    return {
      success: false,
      platform: 'telegram',
      status: 'error',
      message: `Telegram status check failed: ${error.message}`
    };
  }
}
// FIXED: Enhanced WhatsApp login function with proper QR code handling
// FIXED: WhatsApp login with proper QR code handling
// FIXED: WhatsApp login with robust QR code handling
async function checkMediaAccessibility(url) {
  try {
    const response = await axios.head(url, { 
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    return response.status === 200;
  } catch (error) {
    console.warn('⚠️ Media accessibility check failed:', error.message);
    return false;
  }
}
async function loginWhatsApp(userEmail, method = "qr") {
  try {
    const matrix_access_token = DIRECT_ACCESS_TOKEN;
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    const botUserId = "@whatsappbot:matrix.localhost";

    console.log("🚀 Starting WhatsApp login process...", { method });
    
    // Step 1: Find or create direct room
    const roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);
    console.log(`✅ Using room: ${roomId}`);
    
    // Step 2: Send appropriate login command
    const command = method === "phone" ? "!wa login phone" : "!wa login qr";
    console.log(`📤 Sending command: ${command}`);
    
    const sendResponse = await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
      { 
        msgtype: "m.text", 
        body: command
      },
      { 
        headers: { 
          Authorization: `Bearer ${matrix_access_token}`,
          'Content-Type': 'application/json'
        } 
      }
    );
    
    console.log(`✅ Login command sent: ${sendResponse.data.event_id}`);
    
    // Step 3: Poll for response with comprehensive QR code handling
    console.log("⏳ Waiting for response...");
    
    let attempts = 0;
    const maxAttempts = 25; // Reduced for faster response
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Reduced to 2 seconds
      attempts++;
      
      console.log(`📡 Polling for response (${attempts}/${maxAttempts})...`);
      
      try {
        const pollRes = await axios.get(
          `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=20`,
          { 
            headers: { Authorization: `Bearer ${matrix_access_token}` },
            timeout: 8000
          }
        );

        const events = pollRes.data.chunk || [];
        
        // Process events in reverse order (newest first)
        for (const ev of events.reverse()) {
          if (ev.sender === botUserId && ev.content) {
            console.log(`🤖 Bot message - Type: ${ev.content.msgtype}, Body: ${ev.content.body ? ev.content.body.substring(0, 100) : 'No body'}`);
            
            // CASE 1: QR code as image - ENHANCED HANDLING
            if (ev.content.msgtype === "m.image" && ev.content.url) {
              console.log("🎉 QR code image received from bridge!");
              
              const mxcUrl = ev.content.url;
              const httpUrl = resolveMxcUrl(mxcUrl);
              
              // Verify the image is accessible
              const isAccessible = await checkMediaAccessibility(httpUrl);
              
              if (isAccessible) {
                console.log("✅ QR image URL is accessible");
                updatePlatformStatus('whatsapp', true, userEmail);
                
                return { 
                  success: true, 
                  type: "qr_image",
                  qrImageUrl: httpUrl,
                  mxcUrl: mxcUrl,
                  roomId: roomId,
                  message: "QR code received. Scan it with WhatsApp to link your account."
                };
              } else {
                console.log("⚠️ QR image URL not accessible, trying alternative methods...");
                // Continue to look for text-based QR code
              }
            }
            
            // CASE 2: Text message that might contain QR code data
            if (ev.content.body && ev.content.msgtype === "m.text") {
              const body = ev.content.body.trim();
              
              // Look for WhatsApp web URL (most common)
              const webMatch = body.match(/https:\/\/web\.whatsapp\.com\/[^\s]+/);
              if (webMatch) {
                const qrUrl = webMatch[0];
                console.log(`🔗 Found WhatsApp Web URL: ${qrUrl}`);
                
                try {
                  // Generate QR code from the URL
                  const qrImageDataUrl = await QRCode.toDataURL(qrUrl, {
                    width: 300,
                    height: 300,
                    margin: 1,
                    color: {
                      dark: '#000000',
                      light: '#FFFFFF'
                    },
                    errorCorrectionLevel: 'H'
                  });
                  
                  updatePlatformStatus('whatsapp', true, userEmail);
                  
                  return { 
                    success: true, 
                    type: "qr_generated",
                    qrImageUrl: qrImageDataUrl,
                    qrUrl: qrUrl,
                    roomId: roomId,
                    message: "QR code generated. Scan it with WhatsApp."
                  };
                } catch (qrError) {
                  console.error("❌ QR generation failed:", qrError);
                  // Return the URL directly
                  return { 
                    success: true, 
                    type: "qr_direct_link",
                    qrUrl: qrUrl,
                    roomId: roomId,
                    message: "Please visit this URL to link WhatsApp: " + qrUrl
                  };
                }
              }
              
              // Look for any URL that might be a QR code
              const anyUrlMatch = body.match(/https?:\/\/[^\s]+/);
              if (anyUrlMatch && body.length < 500) { // Only if message is not too long
                const url = anyUrlMatch[0];
                console.log(`🔗 Found potential QR URL: ${url}`);
                
                // Check if it looks like a WhatsApp URL
                if (url.includes('whatsapp') || url.includes('web') || url.includes('qr')) {
                  try {
                    const qrImageDataUrl = await QRCode.toDataURL(url, {
                      width: 300,
                      height: 300,
                      margin: 1
                    });
                    
                    updatePlatformStatus('whatsapp', true, userEmail);
                    
                    return { 
                      success: true, 
                      type: "qr_generated",
                      qrImageUrl: qrImageDataUrl,
                      qrUrl: url,
                      roomId: roomId,
                      message: "QR code generated from bridge data."
                    };
                  } catch (error) {
                    console.error("❌ QR generation from URL failed:", error);
                  }
                }
              }
              
              // Look for raw QR code data (alphanumeric string)
              const qrDataMatch = body.match(/([A-Z0-9]{20,})/);
              if (qrDataMatch && !body.includes(' ')) { // If it's mostly just the code
                const qrData = qrDataMatch[1];
                console.log(`🔤 Found QR code data: ${qrData.substring(0, 50)}...`);
                
                try {
                  const qrImageDataUrl = await QRCode.toDataURL(qrData, {
                    width: 300,
                    height: 300,
                    margin: 1
                  });
                  
                  updatePlatformStatus('whatsapp', true, userEmail);
                  
                  return { 
                    success: true, 
                    type: "qr_generated",
                    qrImageUrl: qrImageDataUrl,
                    qrData: qrData,
                    roomId: roomId,
                    message: "QR code generated from bridge data."
                  };
                } catch (error) {
                  console.error("❌ QR generation from data failed:", error);
                }
              }
              
              // Handle status messages
              if (body.includes("already") || body.includes("logged in") || body.includes("authenticated")) {
                updatePlatformStatus('whatsapp', true, userEmail);
                return {
                  success: true,
                  type: "already_connected",
                  message: `WhatsApp: ${body}`,
                  roomId: roomId
                };
              }
              
              if (body.includes("error") || body.includes("fail") || body.includes("invalid")) {
                return {
                  success: false,
                  message: `WhatsApp bridge error: ${body}`,
                  roomId: roomId
                };
              }
              
              if ((body.includes("phone") || body.includes("number")) && !body.includes("QR")) {
                return {
                  success: true,
                  type: "phone_request",
                  message: body,
                  roomId: roomId
                };
              }
              
              // If we get a long message that might contain QR instructions but no URL
              if (body.length > 50 && (body.includes("QR") || body.includes("scan") || body.includes("code"))) {
                console.log("📋 Bridge sent QR code instructions:", body.substring(0, 200));
                return {
                  success: false,
                  type: "qr_instructions",
                  message: "The bridge sent QR code instructions but no usable QR data. Please try phone login method.",
                  instructions: body,
                  roomId: roomId
                };
              }
            }
          }
        }
      } catch (pollError) {
        console.warn(`⚠️ Polling attempt ${attempts} failed:`, pollError.message);
      }
    }
    
    return { 
      success: false, 
      message: "No usable QR code or response received from WhatsApp bridge after waiting.",
      roomId: roomId
    };

  } catch (error) {
    console.error("❌ WhatsApp login failed:", error.response?.data || error.message);
    throw error;
  }
}// FIXED: Enhanced WhatsApp phone login
async function loginWhatsAppPhone(userEmail, phoneNumber) {
  try {
    const matrix_access_token = DIRECT_ACCESS_TOKEN;
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    const botUserId = "@whatsappbot:matrix.localhost";

    console.log("🚀 Starting WhatsApp phone login process...");
    
    // Step 1: Find or create direct room
    const roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);
    console.log(`✅ Using room: ${roomId}`);
    
    // Step 2: Send phone login command
    console.log("📤 Sending 'login phone' command...");
    
    const sendResponse = await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
      { 
        msgtype: "m.text", 
        body: "!wa login phone"
      },
      { 
        headers: { 
          Authorization: `Bearer ${matrix_access_token}`,
          'Content-Type': 'application/json'
        } 
      }
    );
    
    console.log(`✅ Login command sent: ${sendResponse.data.event_id}`);
    
    // Step 3: Wait for phone number request and send it
    console.log("⏳ Waiting for phone number request...");
    
    let attempts = 0;
    const maxAttempts = 15;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempts++;
      
      console.log(`📡 Polling for phone request (${attempts}/${maxAttempts})...`);
      
      try {
        const pollRes = await axios.get(
          `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=20`,
          { 
            headers: { Authorization: `Bearer ${matrix_access_token}` },
            timeout: 8000
          }
        );

        const events = pollRes.data.chunk || [];
        
        for (const ev of events.reverse()) {
          if (ev.sender === botUserId && ev.content?.body) {
            const body = ev.content.body;
            console.log(`🤖 Bot: ${body.substring(0, 100)}`);
            
            // Check if bot is asking for phone number
            if (body.includes("phone") || body.includes("number") || body.includes("+")) {
              console.log("📱 WhatsApp requesting phone number");
              
              if (phoneNumber) {
                console.log("📤 Sending phone number to WhatsApp bot...");
                await axios.put(
                  `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now() + 1}`,
                  { 
                    msgtype: "m.text", 
                    body: phoneNumber
                  },
                  { headers: { Authorization: `Bearer ${matrix_access_token}` } }
                );

                console.log("✅ Phone number sent. Waiting for verification code...");
                
                // Now wait for verification code
                return await this.waitForWhatsAppVerificationCode(roomId, matrix_access_token, userEmail, phoneNumber);
              } else {
                return { 
                  success: true, 
                  type: "phone_request",
                  content: body,
                  roomId,
                  message: "WhatsApp is requesting your phone number"
                };
              }
            }
          }
        }
      } catch (pollError) {
        console.warn(`⚠️ Polling attempt ${attempts} failed:`, pollError.message);
      }
    }
    
    return { 
      success: false, 
      message: "No response from WhatsApp bridge after sending phone number.",
      roomId: roomId
    };

  } catch (error) {
    console.error("❌ WhatsApp phone login failed:", error.response?.data || error.message);
    throw error;
  }
}

// NEW: Helper function to wait for WhatsApp verification code
async function waitForWhatsAppVerificationCode(roomId, accessToken, userEmail, phoneNumber) {
  console.log("⏳ Waiting for verification code...");
  
  let attempts = 0;
  const maxAttempts = 30;
  
  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    attempts++;
    
    console.log(`📡 Waiting for code... Attempt ${attempts}/${maxAttempts}`);
    
    try {
      const pollRes = await axios.get(
        `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=10`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const events = pollRes.data.chunk || [];
      
      for (const ev of events.reverse()) {
        if (ev.sender === "@whatsappbot:matrix.localhost" && ev.content?.body) {
          const body = ev.content.body;
          console.log("Bot response after phone:", body);
          
          // Look for verification code (6-digit code)
          if ((body.length === 6 && /^\d+$/.test(body)) || 
              body.includes("verification code") ||
              body.match(/\b\d{6}\b/)) {
            
            // Extract the code
            let verificationCode = body;
            const codeMatch = body.match(/\b\d{6}\b/);
            if (codeMatch) {
              verificationCode = codeMatch[0];
            }
            
            // Create session for code display
            const sessionId = uuidv4();
            activeSessions.set(sessionId, {
              userEmail,
              roomId,
              matrix_access_token: accessToken,
              phoneNumber,
              timestamp: Date.now()
            });
            
            return { 
              success: true, 
              type: "code_received",
              code: verificationCode,
              roomId,
              sessionId,
              message: "Verification code received from WhatsApp"
            };
          }
          
          // Check for success messages
          if (body.includes("success") || body.includes("logged in") || body.includes("connected")) {
            updatePlatformStatus('whatsapp', true, userEmail);
            return {
              success: true,
              message: `WhatsApp: ${body}`,
              roomId: roomId
            };
          }

          // Check for errors
          if (body.includes("error") || body.includes("failed") || body.includes("invalid")) {
            return {
              success: false,
              message: `WhatsApp error: ${body}`,
              roomId: roomId
            };
          }
        }
      }
    } catch (error) {
      console.warn(`⚠️ Code polling attempt ${attempts} failed:`, error.message);
    }
  }
  
  return { 
    success: false, 
    message: "No verification code received after sending phone number" 
  };
}

// UPDATE: WhatsApp login endpoint to handle both methods properly
app.post("/login/whatsapp", async (req, res) => {
  try {
    const { email, phoneNumber, method = "qr" } = req.body;
    
    console.log("📱 WhatsApp login request:", { email, method, phoneNumber });
    
    if (method === "phone" && phoneNumber) {
      const result = await loginWhatsAppPhone(email, phoneNumber);
      res.json(result);
    } else {
      const result = await loginWhatsApp(email, method);
      res.json(result);
    }
  } catch (error) {
    console.error("❌ WhatsApp login error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

app.post("/status/instagram", async (req, res) => {
  try {
    const { email } = req.body;
    const result = await checkInstagramStatus(email);
    res.json(result);
  } catch (error) {
    res.status(500).json({ 
      success: false,
      platform: 'instagram',
      status: 'error',
      error: error.message 
    });
  }
});

app.post("/status/twitter", async (req, res) => {
  try {
    const { email } = req.body;
    const result = await checkTwitterStatus(email);
    res.json(result);
  } catch (error) {
    res.status(500).json({ 
      success: false,
      platform: 'twitter',
      status: 'error',
      error: error.message 
    });
  }
});

app.post("/status/telegram", async (req, res) => {
  try {
    const { email } = req.body;
    const result = await checkTelegramStatus(email);
    res.json(result);
  } catch (error) {
    res.status(500).json({ 
      success: false,
      platform: 'telegram',
      status: 'error',
      error: error.message 
    });
  }
});

// All platforms status endpoint
app.post("/status/all", async (req, res) => {
  try {
    const { email } = req.body;
    const platforms = ['whatsapp', 'telegram', 'instagram', 'twitter'];
    const results = {};
    
    for (const platform of platforms) {
      try {
        if (platform === 'whatsapp') results.whatsapp = await checkWhatsAppStatus(email);
        if (platform === 'telegram') results.telegram = await checkTelegramStatus(email);
        if (platform === 'instagram') results.instagram = await checkInstagramStatus(email);
        if (platform === 'twitter') results.twitter = await checkTwitterStatus(email);
      } catch (error) {
        results[platform] = { success: false, error: error.message };
      }
    }
    
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// // ENHANCED: Platform detection from admins with better bridge detection
// async function detectPlatformFromAdmins(roomId, accessToken) {
//   try {
//     // 1️⃣ Get power levels
//     const powerRes = await axios.get(
//       `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
//       { headers: { Authorization: `Bearer ${accessToken}` } }
//     );
    
//     const powerLevels = powerRes.data.users || {};
//     const adminUsers = Object.keys(powerLevels).filter(u => powerLevels[u] >= 100);
    
//     if (!adminUsers.length) return { platform: "Matrix", platformCode: "MX" };

//     // 2️⃣ Get member display names for admins
//     const membersRes = await axios.get(
//       `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`,
//       { headers: { Authorization: `Bearer ${accessToken}` } }
//     );

//     const adminMembers = membersRes.data.chunk
//       .filter(m => adminUsers.includes(m.state_key) && m.content?.membership === "join");

//     // 3️⃣ Enhanced platform detection based on admin names and user IDs
//     for (const member of adminMembers) {
//       const displayName = member.content?.displayname || '';
//       const userId = member.state_key || '';
      
//       console.log(`🔍 Checking admin: ${displayName} (${userId})`);

//       // Check display names
//       if (displayName.includes("Whatsapp") || displayName.includes("whatsapp") || 
//           userId.includes("whatsapp")) {
//         return { platform: "Whatsapp", platformCode: "WA" };
//       } else if (displayName.includes("Meta") || displayName.includes("instagram") || 
//                  userId.includes("metabot") || userId.includes("instagram")) {
//         return { platform: "Instagram", platformCode: "IG" };
//       } else if (displayName.includes("Telegram") || displayName.includes("telegram") || 
//                  userId.includes("telegram")) {
//         return { platform: "Telegram", platformCode: "TG" };
//       } else if (displayName.includes("Twitter") || displayName.includes("twitter") || 
//                  userId.includes("twitter")) {
//         return { platform: "Twitter", platformCode: "TW" };
//       }
//     }

//     return { platform: "Matrix", platformCode: "MX" };

//   } catch (err) {
//     console.warn(`⚠️ Failed to detect platform from admins for room ${roomId}:`, err.message);
//     return { platform: "Matrix", platformCode: "MX" };
//   }
// }
// Fallback: detect platform from room name
function detectPlatform(name) {
  let platform = "Matrix";
  let platformCode = "MX";

  if (/\bWA\b|Whatsapp/i.test(name)) {
    platform = "Whatsapp";
    platformCode = "WA";
  } else if (/\bTG\b|Telegram/i.test(name)) {
    platform = "Telegram";
    platformCode = "TG";
  } else if (/\bIG\b|Instagram/i.test(name)) {
    platform = "Instagram";
    platformCode = "IG";
  } else if (/\bTW\b|Twitter/i.test(name)) {
    platform = "Twitter";
    platformCode = "TW";
  }

  return { platform, platformCode };
}

// UPDATED: Extract room metadata with URL resolution and better platform detection
// FIXED: Enhanced room data extraction with better Telegram room name detection
async function extractRoomData(roomId, roomData, accessToken, isInvited = false) {
  let name = "Unknown Room";
  let avatar = null;
  let type = "direct";
  let lastMessage = null;
  let lastMessageTs = null;
  let unreadCount = 0;

  const stateEvents = roomData.state?.events || [];
  const nameEvent = stateEvents.find(e => e.type === "m.room.name");
  const avatarEvent = stateEvents.find(e => e.type === "m.room.avatar");
  const createEvent = stateEvents.find(e => e.type === "m.room.create");
  const canonicalAliasEvent = stateEvents.find(e => e.type === "m.room.canonical_alias");

  if (nameEvent?.content?.name) {
    name = nameEvent.content.name;
  } else if (canonicalAliasEvent?.content?.alias) {
    // Use room alias if no name is set
    name = canonicalAliasEvent.content.alias;
  }

  if (avatarEvent?.content?.url) avatar = resolveMxcUrl(avatarEvent.content.url);
  if (createEvent?.content?.room_type === "group") type = "group";

  // Enhanced platform detection
  let platform = "Matrix";
  let platformCode = "MX";

  try {
    // Method 1: Admin-based detection (most reliable)
    const adminDetection = await detectPlatformFromAdmins(roomId, accessToken);
    platform = adminDetection.platform;
    platformCode = adminDetection.platformCode;
    
    // Method 2: If still Matrix, try room name detection
    if (platform === "Matrix") {
      const nameDetection = detectPlatform(name);
      platform = nameDetection.platform;
      platformCode = nameDetection.platformCode;
    }

    // Method 3: Check for bridge-specific state events
    if (platform === "Matrix") {
      const bridgeEvent = stateEvents.find(e => 
        e.type === "m.room.bridge" || 
        e.type?.includes("bridge") ||
        e.content?.bridge
      );
      if (bridgeEvent) {
        const bridgeInfo = bridgeEvent.content;
        if (bridgeInfo.channel?.platform) {
          platform = bridgeInfo.channel.platform;
          platformCode = getPlatformCode(platform);
        } else if (bridgeInfo.bridgebot === "@telegrambot:matrix.localhost") {
          platform = "Telegram";
          platformCode = "TG";
        } else if (bridgeInfo.bridgebot === "@whatsappbot:matrix.localhost") {
          platform = "Whatsapp";
          platformCode = "WA";
        }
      }
    }

    // Method 4: For Telegram rooms without proper names, try to get participant info
    if (platform === "Telegram" && (name === "Unknown Room" || name.includes("Unknown"))) {
      name = await getTelegramRoomName(roomId, accessToken);
    }

  } catch (error) {
    console.warn(`⚠️ Platform detection failed for room ${roomId}:`, error.message);
    // Fallback to name-based detection
    const fallback = detectPlatform(name);
    platform = fallback.platform;
    platformCode = fallback.platformCode;
  }

  // Get last message
  const timeline = roomData.timeline?.events || [];
  const lastEvent = timeline.slice().reverse().find(e => e.type === "m.room.message");
  if (lastEvent) {
    lastMessage = lastEvent.content?.body || null;
    lastMessageTs = lastEvent.origin_server_ts || null;
  }

  if (roomData.unread_notifications?.notification_count)
    unreadCount = roomData.unread_notifications.notification_count;

  console.log(`🏷️ Room ${roomId}: ${name} -> Platform: ${platform} (${platformCode})`);

  return {
    roomId,
    name,
    avatar,
    type,
    platform,
    platform_code: platformCode,
    last_message: lastMessage,
    last_message_ts: lastMessageTs,
    unread_count: unreadCount,
    invited: isInvited
  };
}

// NEW: Function to get Telegram room names from participant information
async function getTelegramRoomName(roomId, accessToken) {
  try {
    console.log(`🔍 Getting Telegram room name for ${roomId}`);
    
    // Get room members
    const membersResponse = await axios.get(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/joined_members`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    
    const members = membersResponse.data.joined || {};
    const memberUserIds = Object.keys(members);
    
    // Filter out bridge bots and current user
    const participantUserIds = memberUserIds.filter(userId => 
      !userId.includes('bot:matrix.localhost') && 
      !userId.includes('@ohmpatel:matrix.localhost')
    );
    
    if (participantUserIds.length === 0) {
      return "Telegram Chat";
    }
    
    // Get display names for participants
    const participantNames = [];
    for (const userId of participantUserIds.slice(0, 3)) { // Limit to first 3 participants
      const member = members[userId];
      if (member && member.display_name) {
        // Extract actual name from Telegram display name (often includes phone numbers)
        const displayName = member.display_name;
        const nameMatch = displayName.match(/^([^\(]+)/); // Get text before first parenthesis
        if (nameMatch) {
          participantNames.push(nameMatch[1].trim());
        } else {
          participantNames.push(displayName);
        }
      } else {
        // Extract username from user ID
        const usernameMatch = userId.match(/@([^:]+):/);
        if (usernameMatch) {
          participantNames.push(usernameMatch[1]);
        }
      }
    }
    
    if (participantNames.length === 0) {
      return "Telegram Chat";
    }
    
    // Create room name from participants
    let roomName = participantNames.join(', ');
    if (participantUserIds.length > 3) {
      roomName += ` and ${participantUserIds.length - 3} more`;
    }
    
    console.log(`✅ Generated Telegram room name: ${roomName}`);
    return roomName;
    
  } catch (error) {
    console.warn(`⚠️ Could not get Telegram room name:`, error.message);
    return "Telegram Chat";
  }
}

// IMPROVED: Platform detection from admins
async function detectPlatformFromAdmins(roomId, accessToken) {
  try {
    // Get power levels
    const powerRes = await axios.get(
      `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    
    const powerLevels = powerRes.data.users || {};
    const adminUsers = Object.keys(powerLevels).filter(u => powerLevels[u] >= 100);
    
    if (!adminUsers.length) return { platform: "Matrix", platformCode: "MX" };

    // Check for specific bridge bots in admins
    for (const admin of adminUsers) {
      if (admin.includes('telegrambot') || admin.includes('telegram')) {
        return { platform: "Telegram", platformCode: "TG" };
      } else if (admin.includes('whatsappbot') || admin.includes('whatsapp')) {
        return { platform: "Whatsapp", platformCode: "WA" };
      } else if (admin.includes('metabot') || admin.includes('instagram')) {
        return { platform: "Instagram", platformCode: "IG" };
      } else if (admin.includes('twitterbot') || admin.includes('twitter')) {
        return { platform: "Twitter", platformCode: "TW" };
      }
    }

    return { platform: "Matrix", platformCode: "MX" };

  } catch (err) {
    console.warn(`⚠️ Failed to detect platform from admins for room ${roomId}:`, err.message);
    return { platform: "Matrix", platformCode: "MX" };
  }
}
// NEW: Enhanced long-polling sync function
async function longPollingSync(userEmail, socket, since = null) {
  try {
    const syncUrl = `${homeserver}/_matrix/client/v3/sync?timeout=60000${
      since ? `&since=${since}` : ''
    }`;
    
    console.log(`🔄 Long-polling sync for ${userEmail} since: ${since || 'initial'}`);
    
    let response;
    try {
      response = await axios.get(syncUrl, {
        headers: { Authorization: `Bearer ${DIRECT_ACCESS_TOKEN}` },
        timeout: 65000 // 65 seconds timeout
      });
    } catch (error) {
      if (error.code === 'ECONNABORTED' || error.response?.status === 408) {
        console.log(`⏰ Sync timeout for ${userEmail}, restarting...`);
        return since; // Return same since token to continue
      } else {
        throw error;
      }
    }
    
    const data = response.data;
    const nextBatch = data.next_batch;
    
    console.log(`✅ Sync completed for ${userEmail}, processing ${Object.keys(data.rooms?.join || {}).length} rooms`);
    
    // Process all rooms (joined and invited)
    const allRooms = await processAllRooms(data, userEmail, socket);
    
    // Send combined rooms data to frontend
    if (allRooms.length > 0) {
      socket.emit("rooms_updated", {
        rooms: allRooms,
        next_batch: nextBatch
      });
    }
    
    return nextBatch;
    
  } catch (error) {
    console.error(`❌ Long-polling sync error for ${userEmail}:`, error.message);
    socket.emit("sync_error", {
      error: "Sync failed",
      details: error.message
    });
    return since; // Return same since token to retry
  }
}

// NEW: Process all rooms (joined and invited)
async function processAllRooms(syncData, userEmail, socket) {
  const allRooms = [];
  const accessToken = DIRECT_ACCESS_TOKEN;
  
  // Process joined rooms
  const joinedRooms = syncData.rooms?.join || {};
  for (const [roomId, roomData] of Object.entries(joinedRooms)) {
    try {
      const roomInfo = await extractRoomData(roomId, roomData, accessToken, false);
      allRooms.push(roomInfo);
      
      // Process timeline events for real-time updates
      await processRoomTimeline(roomId, roomData, userEmail, socket);
    } catch (error) {
      console.error(`❌ Error processing joined room ${roomId}:`, error.message);
    }
  }
  
  // Process invited rooms (auto-join them)
  const invitedRooms = syncData.rooms?.invite || {};
  for (const [roomId, roomData] of Object.entries(invitedRooms)) {
    try {
      const joinedRoomInfo = await autoJoinRoom(roomId, roomData, userEmail, socket);
      if (joinedRoomInfo) {
        allRooms.push(joinedRoomInfo);
      }
    } catch (error) {
      console.error(`❌ Error auto-joining room ${roomId}:`, error.message);
    }
  }
  
  // Sort all rooms by last message timestamp
  allRooms.sort((a, b) => (b.last_message_ts || 0) - (a.last_message_ts || 0));
  
  return allRooms;
}

// NEW: Process room timeline for real-time events
// UPDATED: Process room timeline for real-time events with proper platform detection
async function processRoomTimeline(roomId, roomData, userEmail, socket) {
  const timeline = roomData.timeline;
  if (!timeline || !timeline.events || timeline.events.length === 0) {
    return;
  }
  
  // Get room info for platform detection - use the actual room data
  let platform = "matrix";
  let roomName = "Unknown";
  
  try {
    // Use the roomData that's already available instead of making a new API call
    const roomInfo = await extractRoomData(roomId, roomData, DIRECT_ACCESS_TOKEN);
    platform = roomInfo.platform.toLowerCase();
    roomName = roomInfo.name;
    console.log(`🔍 Detected platform for room ${roomId}: ${platform} (${roomInfo.platform_code})`);
  } catch (error) {
    console.warn(`⚠️ Could not get room info for ${roomId}:`, error.message);
    // Fallback to admin-based detection
    try {
      const fallbackPlatform = await detectPlatformFromAdmins(roomId, DIRECT_ACCESS_TOKEN);
      platform = fallbackPlatform.platform.toLowerCase();
      console.log(`🔄 Using fallback platform detection for ${roomId}: ${platform}`);
    } catch (fallbackError) {
      console.warn(`⚠️ Fallback platform detection also failed for ${roomId}:`, fallbackError.message);
    }
  }
  
  // Process each event in timeline
  for (const event of timeline.events) {
    // Skip old events if we have limited timeline
    if (timeline.limited && Date.now() - event.origin_server_ts > 60000) {
      continue;
    }
    
    if (event.type === "m.room.message") {
      // Resolve media URLs before sending to frontend
      let content = { ...event.content };
      if (content.url && content.url.startsWith('mxc://')) {
        content.fileUrl = resolveMxcUrl(content.url);
        if (content.msgtype === 'm.image' || content.msgtype === 'm.video') {
          content.thumbnailUrl = getThumbnailUrl(content.url, 400, 300);
        }
      }
      
      // Emit new message event with CORRECT platform
      const messageData = {
        event_id: event.event_id,
        room_id: roomId,
        room_name: roomName,
        sender: event.sender,
        msgtype: event.content.msgtype,
        body: event.content.body,
        content: content, // Use resolved content
        timestamp: event.origin_server_ts,
        platform: platform // This should now be the actual platform (whatsapp, telegram, etc.)
      };
      
      console.log(`📨 Emitting new message for ${roomId} (${platform}):`, messageData.body?.substring(0, 50));
      
      socket.emit("new_message", messageData);
      
    } else if (event.type === "m.reaction") {
      // Emit reaction event with CORRECT platform
      const reactionData = {
        event_id: event.event_id,
        room_id: roomId,
        sender: event.sender,
        type: "reaction",
        related_event_id: event.content["m.relates_to"]?.event_id,
        reaction_key: event.content["m.relates_to"]?.key,
        timestamp: event.origin_server_ts,
        platform: platform // This should now be the actual platform
      };
      
      socket.emit("reaction_added", reactionData);
    }
  }
}
// NEW: Continuous long-polling sync loop
function startLongPollingSync(userEmail, socket) {
  stopUserSyncLoop(userEmail);
  
  let since = null;
  
  const performSync = async () => {
    try {
      since = await longPollingSync(userEmail, socket, since);
      
      // Immediately start next sync after completion
      setTimeout(performSync, 100);
    } catch (error) {
      console.error(`❌ Sync loop error for ${userEmail}:`, error.message);
      // Retry after 5 seconds on error
      setTimeout(performSync, 5000);
    }
  };
  
  // Start the sync loop
  performSync();
  
  console.log(`🔄 Started long-polling sync for ${userEmail}`);
}

function stopUserSyncLoop(userEmail) {
  const loop = userSyncLoops.get(userEmail);
  if (loop) {
    clearInterval(loop);
    userSyncLoops.delete(userEmail);
  }
}

// WebSocket Connection Handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join_user", async (userEmail) => {
    userSocketMap.set(userEmail, socket.id);
    socket.join(userEmail);
    console.log(`User ${userEmail} registered with socket ${socket.id}`);
    
    // Send current platform status to the user
    const platforms = ['whatsapp', 'telegram', 'instagram', 'twitter'];
    platforms.forEach(platform => {
      const status = getPlatformStatus(platform, userEmail);
      socket.emit('platform_status', {
        platform,
        connected: status.connected,
        userEmail
      });
    });
    
    // Start long-polling sync
    startLongPollingSync(userEmail, socket);
  });

  // Handle sync request via WebSocket
  socket.on("request_sync", async (data) => {
    try {
      const { email, since } = data;
      console.log(`📡 WebSocket sync requested by ${email}`);
      
      await longPollingSync(email, socket, since);
      
      socket.emit("sync_complete", {
        success: true,
        message: "Initial sync completed"
      });
    } catch (error) {
      console.error("WebSocket sync error:", error.message);
      socket.emit("sync_error", {
        error: "Sync failed",
        details: error.message
      });
    }
  });

  // Handle manual sync trigger
  socket.on("trigger_sync", async (data) => {
    try {
      const { email } = data;
      console.log(`🔄 Manual sync triggered by ${email}`);
      
      await longPollingSync(email, socket);
      
      socket.emit("sync_update", {
        type: "manual_sync_complete",
        message: "Manual sync completed successfully"
      });
    } catch (error) {
      console.error("Manual sync error:", error.message);
      socket.emit("sync_error", {
        error: "Manual sync failed",
        details: error.message
      });
    }
  });

  socket.on("disconnect", () => {
    for (const [email, socketId] of userSocketMap.entries()) {
      if (socketId === socket.id) {
        userSocketMap.delete(email);
        stopUserSyncLoop(email);
        console.log(`User ${email} disconnected`);
        break;
      }
    }
  });
});

// UPDATED: /get_rooms endpoint with URL resolution
app.post("/api/get_rooms", async (req, res) => {
  const accessToken = DIRECT_ACCESS_TOKEN;
  
  try {
    const filter = encodeURIComponent(JSON.stringify({
      room: { timeline: { limit: 1 }, state: { limit: 1 }, ephemeral: { limit: 0 }, include_leave: false },
      presence: { limit: 0 }
    }));

    const syncResponse = await axios.get(
      `${homeserver}/_matrix/client/v3/sync?filter=${filter}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const rooms = [];

    // 1️⃣ Joined rooms
    const joinedRooms = Object.entries(syncResponse.data.rooms?.join || {});
    for (const [roomId, roomData] of joinedRooms) {
      try {
        const roomInfo = await extractRoomData(roomId, roomData, accessToken, false);
        rooms.push(roomInfo);
      } catch (error) {
        console.error(`❌ Error processing joined room ${roomId}:`, error.message);
      }
    }

    // 2️⃣ Invited rooms
    const inviteRooms = Object.entries(syncResponse.data.rooms?.invite || {});
    for (const [roomId, roomData] of inviteRooms) {
      try {
        const roomInfo = await extractRoomData(roomId, roomData, accessToken, true);
        rooms.push(roomInfo);
      } catch (error) {
        console.error(`❌ Error processing invited room ${roomId}:`, error.message);
      }
    }

    // Sort rooms by last_message_ts
    rooms.sort((a, b) => (b.last_message_ts || 0) - (a.last_message_ts || 0));

    res.json({ success: true, rooms });

  } catch (err) {
    console.error("Get rooms error:", err.message);
    res.status(500).json({ error: "Failed to get rooms" });
  }
});

app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    
    const existingUser = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: "User already exists" });
    }

    const matrixUsername = email.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "");
    const matrixRes = await axios.post(`${homeserver}/_matrix/client/v3/register`, {
      username: matrixUsername,
      password,
      auth: { type: "m.login.dummy" },
    });

    const { user_id, access_token, device_id } = matrixRes.data;

    await pool.query(
      `INSERT INTO users (id, email, password_hash, matrix_user_id, matrix_access_token, device_id, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [id, email, passwordHash, user_id, access_token, device_id]
    );

    res.json({ 
      success: true, 
      matrix_user_id: user_id, 
      matrix_access_token: access_token, 
      device_id 
    });
  } catch (error) {
    console.error("Registration error:", error.response?.data || error.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const matrixRes = await axios.post(`${homeserver}/_matrix/client/v3/login`, {
      type: "m.login.password",
      identifier: { 
        type: "m.id.user", 
        user: ""
      },
      password:"",
    });

    const { access_token, device_id } = matrixRes.data;

    res.json({ 
      success: true, 
      matrix_access_token: access_token, 
      device_id 
    });
  } catch (error) {
    console.error("Login error:", error.response?.data || error.message);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/logout", async (req, res) => {
  try {
    const { email } = req.body;
    
    const userResult = await pool.query("SELECT matrix_access_token FROM users WHERE email=$1", [email]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    const matrixAccessToken = userResult.rows[0].matrix_access_token;
    
    await axios.post(`${homeserver}/_matrix/client/v3/logout`, {}, {
      headers: { Authorization: `Bearer ${matrixAccessToken}` },
    });

    await pool.query(
      "UPDATE users SET matrix_access_token=NULL, last_sync_token=NULL WHERE email=$1",
      [email]
    );

    stopUserSyncLoop(email);

    res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error.response?.data || error.message);
    res.status(500).json({ error: "Logout failed" });
  }
});
// // NEW: WhatsApp phone login function
// async function loginWhatsAppPhone(userEmail, phoneNumber) {
//   try {
//     const matrix_access_token = DIRECT_ACCESS_TOKEN;
//     const matrix_user_id = "@ohmpatel:matrix.localhost";
//     const botUserId = "@whatsappbot:matrix.localhost";

//     console.log("🚀 Starting WhatsApp phone login process...");
    
//     // Step 1: Find or create direct room
//     const roomId = await ensureDirectRoom(matrix_user_id, botUserId, matrix_access_token);
//     console.log(`✅ Using room: ${roomId}`);
    
//     // Step 2: Send phone login command
//     console.log("📤 Sending 'login phone' command...");
    
//     const sendResponse = await axios.put(
//       `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
//       { 
//         msgtype: "m.text", 
//         body: "!wa login phone"
//       },
//       { 
//         headers: { 
//           Authorization: `Bearer ${matrix_access_token}`,
//           'Content-Type': 'application/json'
//         } 
//       }
//     );
    
//     console.log(`✅ Login command sent: ${sendResponse.data.event_id}`);
    
//     // Step 3: Wait for phone number request
//     console.log("⏳ Waiting for phone number request...");
    
//     let attempts = 0;
//     const maxAttempts = 10;
    
//     while (attempts < maxAttempts) {
//       await new Promise(resolve => setTimeout(resolve, 2000));
//       attempts++;
      
//       console.log(`📡 Polling for phone request (${attempts}/${maxAttempts})...`);
      
//       try {
//         const pollRes = await axios.get(
//           `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=20`,
//           { 
//             headers: { Authorization: `Bearer ${matrix_access_token}` },
//             timeout: 5000
//           }
//         );

//         const events = pollRes.data.chunk || [];
        
//         for (const ev of events) {
//           if (ev.sender === botUserId && ev.content?.body) {
//             const body = ev.content.body;
//             console.log(`🤖 Bot: ${body.substring(0, 100)}`);
            
//             // Check if bot is asking for phone number
//             if (body.includes("phone") || body.includes("number") || body.includes("+")) {
//               console.log("📱 WhatsApp requesting phone number");
              
//               if (phoneNumber) {
//                 console.log("Sending phone number to WhatsApp bot...");
//                 await axios.put(
//                   `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now() + 1}`,
//                   { 
//                     msgtype: "m.text", 
//                     body: phoneNumber
//                   },
//                   { headers: { Authorization: `Bearer ${matrix_access_token}` } }
//                 );

//                 console.log("Phone number sent. Waiting for verification code...");
                
//                 // Wait for verification code
//                 let codeAttempts = 0;
//                 const maxCodeAttempts = 20;
                
//                 while (codeAttempts < maxCodeAttempts) {
//                   await new Promise(resolve => setTimeout(resolve, 3000));
//                   codeAttempts++;
                  
//                   console.log(`📡 Waiting for code... Attempt ${codeAttempts}/${maxCodeAttempts}`);
                  
//                   const codeRes = await axios.get(
//                     `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=10`,
//                     { headers: { Authorization: `Bearer ${matrix_access_token}` } }
//                   );

//                   const codeEvents = codeRes.data.chunk || [];
                  
//                   for (const codeEv of codeEvents.reverse()) {
//                     if (codeEv.sender === botUserId && codeEv.content?.body) {
//                       const codeBody = codeEv.content.body;
//                       console.log("Bot response after phone:", codeBody);
                      
//                       // Look for verification code (6-digit code)
//                       if ((codeBody.length === 6 && /^\d+$/.test(codeBody)) || 
//                           codeBody.includes("verification code") ||
//                           codeBody.match(/\b\d{6}\b/)) {
                        
//                         // Extract the code
//                         let verificationCode = codeBody;
//                         const codeMatch = codeBody.match(/\b\d{6}\b/);
//                         if (codeMatch) {
//                           verificationCode = codeMatch[0];
//                         }
                        
//                         // Create session for code display
//                         const sessionId = uuidv4();
//                         activeSessions.set(sessionId, {
//                           userEmail,
//                           roomId,
//                           matrix_access_token,
//                           phoneNumber,
//                           timestamp: Date.now()
//                         });
                        
//                         return { 
//                           success: true, 
//                           type: "code_received",
//                           code: verificationCode,
//                           roomId,
//                           sessionId,
//                           message: "Verification code received from WhatsApp"
//                         };
//                       }
                      
//                       // Check for success messages
//                       if (codeBody.includes("success") || codeBody.includes("logged in") || codeBody.includes("connected")) {
//                         updatePlatformStatus('whatsapp', true, userEmail);
//                         return {
//                           success: true,
//                           message: `WhatsApp: ${codeBody}`,
//                           roomId: roomId
//                         };
//                       }

//                       // Check for errors
//                       if (codeBody.includes("error") || codeBody.includes("failed") || codeBody.includes("invalid")) {
//                         return {
//                           success: false,
//                           message: `WhatsApp error: ${codeBody}`,
//                           roomId: roomId
//                         };
//                       }
//                     }
//                   }
//                 }
                
//                 return { 
//                   success: false, 
//                   message: "No verification code received after sending phone number" 
//                 };
//               } else {
//                 return { 
//                   success: true, 
//                   type: "phone_request",
//                   content: body,
//                   roomId,
//                   message: "WhatsApp is requesting your phone number"
//                 };
//               }
//             }
//           }
//         }
//       } catch (pollError) {
//         console.warn(`⚠️ Polling attempt ${attempts} failed:`, pollError.message);
//       }
//     }
    
//     return { 
//       success: false, 
//       message: "No response from WhatsApp bridge after waiting.",
//       roomId: roomId
//     };

//   } catch (error) {
//     console.error("❌ WhatsApp phone login failed:", error.response?.data || error.message);
//     throw error;
//   }
// }
// // UPDATE: WhatsApp login endpoint to support both methods
app.post("/login/whatsapp", async (req, res) => {
  try {
    const { email, phoneNumber, method = "qr" } = req.body;
    
    console.log("📱 WhatsApp login request:", { email, method, phoneNumber });
    
    if (method === "phone" && phoneNumber) {
      const result = await loginWhatsAppPhone(email, phoneNumber);
      res.json(result);
    } else {
      const result = await loginWhatsApp(email);
      res.json(result);
    }
  } catch (error) {
    console.error("❌ WhatsApp login error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});
app.post("/login/telegram", async (req, res) => {
  try {
    const { email, phoneNumber } = req.body;
    const result = await loginTelegram(email, phoneNumber);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/verify/telegram", async (req, res) => {
  try {
    const { sessionId, code } = req.body;
    const result = await verifyTelegramCode(sessionId, code);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/login/instagram", async (req, res) => {
  try {
    const { email } = req.body;
    const result = await loginInstagram(email);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/login/twitter", async (req, res) => {
  try {
    const { email } = req.body;
    const result = await loginTwitter(email);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// NEW: Enhanced Disconnect platform endpoint
app.post("/disconnect", async (req, res) => {
  try {
    const { email, platform } = req.body;
    
    const accessToken = DIRECT_ACCESS_TOKEN;
    const matrix_user_id = "@ohmpatel:matrix.localhost";
    
    // Map platform to bot user ID
    const botMap = {
      whatsapp: "@whatsappbot:matrix.localhost",
      telegram: "@telegrambot:matrix.localhost", 
      instagram: "@metabot:matrix.localhost",
      twitter: "@twitterbot:matrix.localhost"
    };
    
    const botUserId = botMap[platform.toLowerCase()];
    if (!botUserId) {
      return res.status(400).json({ error: "Invalid platform" });
    }
    
    const roomId = await ensureDirectRoom(matrix_user_id, botUserId, accessToken);
    
    // Send logout command to bridge
    await axios.put(
      `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${Date.now()}`,
      { 
        msgtype: "m.text", 
        body: "logout"
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    
    // Update platform status
    updatePlatformStatus(platform, false, email);
    
    res.json({ 
      success: true, 
      message: `${platform} disconnected successfully` 
    });
    
  } catch (error) {
    console.error("Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect platform" });
  }
});

app.post("/search-user", async (req, res) => {
  try {
    const { email, search_term } = req.body;
    
    if (!email || !search_term) {
      return res.status(400).json({ error: "Missing email or search term" });
    }

    const userResult = await pool.query(
      "SELECT matrix_access_token FROM users WHERE email=$1",
      [email]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    let accessToken = userResult.rows[0].matrix_access_token;

    try {
      const searchResponse = await axios.post(
        `${homeserver}/_matrix/client/v3/user_directory/search`,
        {
          search_term,
          limit: 10
        },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      res.json({
        success: true,
        results: searchResponse.data.results
      });
    } catch (error) {
      if (error.response?.status === 401) {
        const newTokens = await refreshToken(email);
        if (newTokens) {
          accessToken = newTokens.newAccessToken;
          
          const searchResponse = await axios.post(
            `${homeserver}/_matrix/client/v3/user_directory/search`,
            {
              search_term,
              limit: 10
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          res.json({
            success: true,
            results: searchResponse.data.results
          });
        } else {
          throw new Error("Failed to refresh token");
        }
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error("Search user error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to search users" });
  }
});
// FIXED: Enhanced /api/getRoomMessages endpoint with URL resolution
app.post("/api/getRoomMessages", async (req, res) => {
    try {
        const { room_id, user_email } = req.body;

        const accessToken = DIRECT_ACCESS_TOKEN;

        // ✅ 1. Fetch messages (increase limit to get more context for reactions)
        const messagesResponse = await axios.get(
            `${homeserver}/_matrix/client/v3/rooms/${room_id}/messages?dir=b&limit=100`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const allEvents = messagesResponse.data.chunk;
        
        // ✅ 2. Separate messages and reactions
        const messages = allEvents.filter(event => event.type === "m.room.message");
        const reactionEvents = allEvents.filter(event => event.type === "m.reaction");

        // ✅ 3. Aggregate reactions by message
        const aggregatedReactions = aggregateReactions(reactionEvents);

        // ✅ 4. Fetch room members (to map sender → name)
        const membersResponse = await axios.get(
            `${homeserver}/_matrix/client/v3/rooms/${room_id}/members`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const members = membersResponse.data.chunk || [];
        const senderMap = {};
        members.forEach((m) => {
            senderMap[m.state_key] = {
                name: m.content.displayname || m.state_key,
                avatar: m.content.avatar_url ? resolveMxcUrl(m.content.avatar_url) : null, // Resolve avatar URL
            };
        });

        // ✅ 5. Attach sender name, avatar, and reactions to each message
        const enrichedMessages = messages.map((event) => {
            const senderInfo = senderMap[event.sender] || {};
            const messageReactions = aggregatedReactions[event.event_id] || [];
            
            // Resolve media URLs in content
            let content = { ...event.content };
            if (content.url && content.url.startsWith('mxc://')) {
                content.fileUrl = resolveMxcUrl(content.url);
                // For images/videos, also create thumbnail URLs
                if (content.msgtype === 'm.image' || content.msgtype === 'm.video') {
                    content.thumbnailUrl = getThumbnailUrl(content.url, 400, 300);
                }
            }
            
            // Handle reply_to data
            let reply_to = null;
            if (event.content["m.relates_to"] && event.content["m.relates_to"]["m.in_reply_to"]) {
                reply_to = {
                    id: event.content["m.relates_to"]["m.in_reply_to"].event_id,
                    sender: event.content["m.relates_to"]["m.in_reply_to"].sender,
                    content: event.content["m.relates_to"]["m.in_reply_to"].content?.body || "Original message"
                };
            }
            
            return {
                event_id: event.event_id,
                sender_id: event.sender,
                sender_name: senderInfo.name || event.sender,
                sender_avatar: senderInfo.avatar,
                type: event.content.msgtype,
                body: event.content.body,
                timestamp: event.origin_server_ts,
                content: content, // Use the resolved content
                reactions: messageReactions,
                reply_to: reply_to
            };
        });

        // ✅ 6. Sort messages by timestamp (oldest first)
        enrichedMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        res.json({ 
            success: true, 
            messages: enrichedMessages,
            reactionSummary: `Found ${reactionEvents.length} reaction events aggregated into ${Object.keys(aggregatedReactions).length} messages with reactions`
        });
    } catch (error) {
        console.error("Get room messages error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to get messages" });
    }
});
// FIXED: Enhanced sendMessage endpoint with better file handling
app.post("/api/sendMessage", upload.array("files", 10), async (req, res) => {
  try {
    const { email, roomId, text, reply_to } = req.body;
    const files = req.files || [];
    
    console.log("📨 Sending message request:", { 
      email, 
      roomId, 
      text: text ? `${text.substring(0, 100)}...` : 'No text',
      fileCount: files.length,
      reply_to: reply_to ? 'Present' : 'None'
    });

    // Use the direct access token since frontend doesn't send proper auth
    const accessToken = DIRECT_ACCESS_TOKEN;

    // Validate required fields
    if (!roomId) {
      return res.status(400).json({ 
        success: false, 
        error: "Room ID is required" 
      });
    }

    if (!text && files.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: "Message text or file is required" 
      });
    }

    const uploadResults = [];
    
    // Send text message first if it exists
    if (text && text.trim()) {
      try {
        const textTxnId = uuidv4();
        let textContent = { 
          msgtype: "m.text", 
          body: text 
        };
        
        if (reply_to) {
          try {
            const replyData = typeof reply_to === 'string' ? JSON.parse(reply_to) : reply_to;
            textContent["m.relates_to"] = {
              "m.in_reply_to": {
                event_id: replyData.id
              }
            };
            console.log('✅ Reply data parsed for text message:', replyData);
          } catch (parseError) {
            console.warn("⚠️ Failed to parse reply_to for text:", parseError);
          }
        }

        const textResponse = await axios.put(
          `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${textTxnId}`,
          textContent,
          { 
            headers: { 
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            } 
          }
        );

        uploadResults.push({
          type: "text",
          event_id: textResponse.data.event_id,
          body: text
        });

        // Emit socket event for text
        if (email) {
          const socketId = userSocketMap.get(email);
          if (socketId) {
            io.to(socketId).emit("message_sent", {
              roomId,
              event_id: textResponse.data.event_id,
              sender: email,
              body: text,
              timestamp: Date.now(),
              reply_to: reply_to
            });
          }
        }
      } catch (textError) {
        console.error("❌ Error sending text message:", textError);
        uploadResults.push({
          type: "text",
          error: textError.message
        });
      }
    }

    // Process each file
    for (const file of files) {
      try {
        const buffer = file.buffer;
        const filename = file.originalname;
        const mimetype = file.mimetype;

        console.log(`📤 Processing file: ${filename} (${mimetype}, ${buffer.length} bytes)`);

        let mediaUrl = null;
        const { msgtype, info } = getFileInfo(mimetype, filename);
        info.size = buffer.length;

        // Get additional info for images and videos
        if (msgtype === "m.image") {
          try {
            const dimensions = sizeOf(buffer);
            if (dimensions.width) info.w = dimensions.width;
            if (dimensions.height) info.h = dimensions.height;
          } catch (error) {
            console.warn("⚠️ Error getting image dimensions:", error);
          }
        } else if (msgtype === "m.video") {
          // For videos, we can get dimensions from the first frame if needed
          // This is simplified - in production you might want to use ffprobe
          console.log(`🎥 Video file detected: ${filename}`);
        }

        // Upload to media repository (Cloudinary or Matrix)
        try {
          mediaUrl = await uploadMedia(buffer, filename, mimetype, accessToken);
          console.log(`✅ File uploaded successfully: ${mediaUrl}`);
        } catch (uploadError) {
          console.error("❌ Media upload failed:", uploadError);
          uploadResults.push({
            filename,
            error: `Upload failed: ${uploadError.message}`
          });
          continue; // Skip to next file
        }

        const content = {
          msgtype,
          body: filename,
          url: mediaUrl,
          info
        };

        // Handle reply for files
        if (reply_to) {
          try {
            const replyData = typeof reply_to === 'string' ? JSON.parse(reply_to) : reply_to;
            content["m.relates_to"] = {
              "m.in_reply_to": {
                event_id: replyData.id
              }
            };
          } catch (parseError) {
            console.warn("⚠️ Failed to parse reply_to for file:", parseError);
          }
        }

        // Send file message
        const fileTxnId = uuidv4();
        console.log(`📤 Sending file message to Matrix: ${filename}`);
        
        const sendResponse = await axios.put(
          `${homeserver}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${fileTxnId}`,
          content,
          { 
            headers: { 
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
        );

        console.log(`✅ File message sent successfully: ${sendResponse.data.event_id}`);

        uploadResults.push({
          filename,
          event_id: sendResponse.data.event_id,
          media_url: mediaUrl,
          type: msgtype
        });

        // Emit socket event for each file
        if (email) {
          const socketId = userSocketMap.get(email);
          if (socketId) {
            io.to(socketId).emit("message_sent", {
              roomId,
              event_id: sendResponse.data.event_id,
              sender: email,
              body: filename,
              type: msgtype,
              media_url: mediaUrl,
              timestamp: Date.now(),
              reply_to: reply_to
            });
          }
        }

      } catch (fileError) {
        console.error(`❌ Error uploading file ${file.originalname}:`, fileError);
        uploadResults.push({
          filename: file.originalname,
          error: fileError.message
        });
      }
    }

    console.log("✅ All files processed:", uploadResults);

    // Check if any files were successfully uploaded
    const successfulUploads = uploadResults.filter(r => !r.error);
    
    if (successfulUploads.length === 0 && (!text || text.trim() === '')) {
      return res.status(400).json({ 
        success: false,
        error: "No messages or files were successfully sent",
        results: uploadResults
      });
    }

    res.json({
      success: true,
      results: uploadResults,
      message: `Successfully sent ${successfulUploads.length} items`
    });

  } catch (error) {
    console.error("❌ Send message error:", error.response?.data || error.message);
    res.status(500).json({ 
      success: false,
      error: "Failed to send message",
      details: error.message 
    });
  }
});

// Enhanced reaction endpoint
app.post("/send-reaction", async (req, res) => {
    try {
        const { user_email, room_id, event_id, emoji } = req.body;
        
        console.log("🎯 Reaction request received:", {
            user_email,
            room_id,
            event_id,
            emoji
        });

        const accessToken = DIRECT_ACCESS_TOKEN;
        const txnId = uuidv4();

        const content = {
            "m.relates_to": {
                "rel_type": "m.annotation",
                "event_id": event_id,
                "key": emoji
            }
        };

        console.log("📤 Sending reaction to Matrix:", {
            room_id,
            event_id,
            emoji,
            txnId
        });

        const response = await axios.put(
            `${homeserver}/_matrix/client/v3/rooms/${room_id}/send/m.reaction/${txnId}`,
            content,
            { 
                headers: { 
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                } 
            }
        );

        console.log("✅ Reaction sent successfully:", response.data);

        // Enhanced socket emission
        const socketId = userSocketMap.get(user_email);
        if (socketId) {
            // Get platform for this room
            let platform = "whatsapp"; // Default, you might want to detect this properly
            try {
                // Try to detect platform from room data
                const roomResponse = await axios.get(
                    `${homeserver}/_matrix/client/v3/rooms/${room_id}/state/m.room.power_levels`,
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );
                
                const powerLevels = roomResponse.data.users || {};
                const adminUsers = Object.keys(powerLevels).filter(u => powerLevels[u] >= 100);
                
                // Simple platform detection
                if (adminUsers.some(u => u.includes('whatsapp'))) platform = "whatsapp";
                else if (adminUsers.some(u => u.includes('telegram'))) platform = "telegram";
                else if (adminUsers.some(u => u.includes('instagram'))) platform = "instagram";
                else if (adminUsers.some(u => u.includes('twitter'))) platform = "twitter";
                
            } catch (detectError) {
                console.warn("Could not detect platform, using default:", detectError.message);
            }

            // Emit to the specific user
            io.to(socketId).emit("sync_update", {
                type: "reaction",
                room_id: room_id,
                event_id: response.data.event_id,
                related_event_id: event_id,
                reaction_key: emoji,
                sender: user_email,
                timestamp: Date.now(),
                platform: platform
            });

            // Also emit to all users in the room for real-time updates
            io.to(room_id).emit("reaction_added", {
                room_id: room_id,
                event_id: response.data.event_id,
                related_event_id: event_id,
                reaction_key: emoji,
                sender: user_email,
                timestamp: Date.now(),
                platform: platform
            });
            
            console.log("📡 Emitted reaction events to room:", room_id);
        }

        res.json({ 
            success: true, 
            event_id: response.data.event_id,
            message: "Reaction added successfully"
        });

    } catch (error) {
        console.error("❌ Send reaction error:", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message
        });
        
        res.status(500).json({ 
            error: "Failed to send reaction",
            details: error.response?.data || error.message
        });
    }
});

app.post("/create-group", async (req, res) => {
  try {
    const { creator_email, group_name, members } = req.body;
    
    if (!creator_email || !group_name || !members?.length) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const userResult = await pool.query(
      "SELECT matrix_access_token, matrix_user_id FROM users WHERE email=$1",
      [creator_email]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    let accessToken = userResult.rows[0].matrix_access_token;
    const matrixUserId = userResult.rows[0].matrix_user_id;

    try {
      const createRoomResponse = await axios.post(
        `${homeserver}/_matrix/client/v3/createRoom`,
        {
          name: group_name,
          preset: "private_chat",
          visibility: "private",
          creation_content: {
            "m.federate": false
          }
        },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const roomId = createRoomResponse.data.room_id;

      for (const member of members) {
        try {
          await axios.post(
            `${homeserver}/_matrix/client/v3/rooms/${roomId}/invite`,
            { user_id: member },
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
        } catch (error) {
          console.error(`Failed to invite ${member}:`, error.message);
        }
      }

      await pool.query(
        `INSERT INTO rooms (user_email, room_id, name, type, platform, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [creator_email, roomId, group_name, "group", "matrix"]
      );

      res.json({ success: true, room_id: roomId });
    } catch (error) {
      if (error.response?.status === 401) {
        const newTokens = await refreshToken(creator_email);
        if (newTokens) {
          accessToken = newTokens.newAccessToken;
          
          const createRoomResponse = await axios.post(
            `${homeserver}/_matrix/client/v3/createRoom`,
            {
              name: group_name,
              preset: "private_chat",
              visibility: "private"
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          const roomId = createRoomResponse.data.room_id;

          for (const member of members) {
            try {
              await axios.post(
                `${homeserver}/_matrix/client/v3/rooms/${roomId}/invite`,
                { user_id: member },
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
            } catch (error) {
              console.error(`Failed to invite ${member}:`, error.message);
            }
          }

          res.json({ success: true, room_id: roomId });
        } else {
          throw new Error("Failed to refresh token");
        }
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error("Create group error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create group" });
  }
});


// ENHANCED: AI Rephrase endpoint with tone options and message context
app.post("/ai_rephrase", async (req, res) => {
    try {
        const { text, tone, user_email, room_id, platform, include_context } = req.body;
        
        console.log('🤖 AI Rephrase request:', {
            text_length: text?.length,
            tone,
            user_email,
            room_id,
            platform,
            include_context
        });

        // Validate input
        if (!text || !text.trim()) {
            return res.status(400).json({
                success: false,
                error: 'Text is required'
            });
        }

        // Get recent messages for context if requested and room_id is provided
        let recentMessages = [];
        if (include_context && room_id) {
            try {
                recentMessages = await getRecentRoomMessages(room_id, 10); // Reduced to 10 for better performance
                console.log(`📚 Found ${recentMessages.length} recent messages for context`);
            } catch (contextError) {
                console.warn('⚠️ Could not fetch message context:', contextError.message);
                // Continue without context
            }
        }

        // Call Gemini AI with context and tone
        const rephrasedText = await callGeminiAI(text, tone, recentMessages);
        
        if (!rephrasedText) {
            throw new Error('AI service returned empty response');
        }

        res.json({
            success: true,
            rephrased_text: rephrasedText,
            original_text: text,
            tone_used: tone || 'default',
            context_messages_count: recentMessages.length
        });

    } catch (error) {
        console.error('❌ AI rephrase error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to rephrase text'
        });
    }
});

// NEW: Get recent room messages for context
async function getRecentRoomMessages(roomId, limit = 10) {
    try {
        const accessToken = DIRECT_ACCESS_TOKEN;
        
        const messagesResponse = await axios.get(
            `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=${limit}`,
            { 
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 10000
            }
        );

        const allEvents = messagesResponse.data.chunk || [];
        
        // Filter and format messages
        const messages = allEvents
            .filter(event => event.type === "m.room.message" && event.content?.body)
            .map(event => ({
                sender: event.sender,
                body: event.content.body,
                timestamp: event.origin_server_ts,
                type: event.content.msgtype
            }))
            .reverse(); // Reverse to get chronological order

        console.log(`📨 Retrieved ${messages.length} messages for AI context`);
        return messages;

    } catch (error) {
        console.error('❌ Error fetching recent messages:', error.message);
        throw error;
    }
}

// FIXED: Call Gemini AI with better error handling and prompts
async function callGeminiAI(text, tone, contextMessages = []) {
    try {
        const apiKey = "AIzaSyAPkVWClLtqK-zJkRKhAuwLbNakB9YT4jQ";
        if (!apiKey) {
            throw new Error('Gemini API key is not configured');
        }

        console.log('🔑 Gemini API Key present:', !!apiKey);

        // Initialize the Google Generative AI
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", // Use gemini-pro which is more reliable
        });

        // Build context from recent messages (simplified)
        let contextString = '';
        if (contextMessages.length > 0) {
            // Take only last 5 messages to avoid token limits
            const recentMessages = contextMessages.slice(-5);
            contextString = `Here is the recent conversation context:\n${recentMessages.map(msg => 
                `${msg.sender.split(':')[0]}: ${msg.body}`
            ).join('\n')}\n\n`;
        }

        // Build tone instruction
        let toneInstruction = '';
        if (tone && tone.trim() !== '') {
            toneInstruction = `Rephrase the following text in a ${tone} tone. `;
        } else {
            toneInstruction = 'Rephrase the following text to make it more clear and effective. ';
        }

        // SIMPLIFIED PROMPT - More direct and clear
        const prompt = `${contextString}${toneInstruction}
Original text: "${text}"

IMPORTANT: Provide ONLY the rephrased text. Do not add any explanations, notes, or additional text. Just return the rephrased version of the original text.`;

        console.log('🤖 Calling Gemini AI with prompt:', prompt);
        
        try {
            // Generate content with timeout
            const result = await model.generateContent(prompt);
            const response = await result.response;
            
            if (!response) {
                throw new Error('No response from Gemini AI');
            }
            
            const rephrasedText = response.text();
            
            if (!rephrasedText || rephrasedText.trim() === '') {
                console.log('⚠️ Empty response from Gemini, using fallback');
                return getFallbackRephrase(text, tone);
            }
            
            const trimmedText = rephrasedText.trim();
            
            // Validate that the response is actually different from original
            if (trimmedText.toLowerCase() === text.toLowerCase()) {
                console.log('⚠️ Response same as original, using fallback');
                return getFallbackRephrase(text, tone);
            }
            
            console.log('✅ AI Rephrase successful - Original:', text, 'Rephrased:', trimmedText);
            return trimmedText;

        } catch (genError) {
            console.error('❌ Gemini generation error:', genError);
            return getFallbackRephrase(text, tone);
        }

    } catch (error) {
        console.error('❌ Gemini AI call failed:', error.message);
        return getFallbackRephrase(text, tone);
    }
}

// IMPROVED: Better fallback rephrasing
function getFallbackRephrase(text, tone) {
    console.log('🔄 Using enhanced fallback rephrasing');
    
    if (!text || text.trim() === '') {
        return "Please enter some text to rephrase.";
    }

    // Simple rephrasing patterns based on tone
    const textLower = text.toLowerCase();
    let rephrased = text;

    if (tone) {
        switch (tone.toLowerCase()) {
            case 'polite':
                if (!textLower.startsWith('could you') && !textLower.startsWith('please')) {
                    rephrased = `Could you please ${textLower}?`;
                } else {
                    rephrased = text; // Already polite
                }
                break;
            case 'friendly':
                if (!textLower.startsWith('hey') && !textLower.startsWith('hi')) {
                    rephrased = `Hey! ${text}`;
                } else {
                    rephrased = text; // Already friendly
                }
                break;
            case 'professional':
                if (!textLower.startsWith('i would') && !textLower.startsWith('please')) {
                    rephrased = `I would like to request that ${textLower}`;
                } else {
                    rephrased = text; // Already professional
                }
                break;
            case 'request':
                if (!textLower.includes('would you') && !textLower.includes('could you')) {
                    rephrased = `Would you mind ${textLower}?`;
                } else {
                    rephrased = text; // Already a request
                }
                break;
            case 'order':
                if (!textLower.endsWith('please') && !textLower.endsWith('thank you')) {
                    rephrased = `${text}. Thank you.`;
                } else {
                    rephrased = text; // Already ordered
                }
                break;
            default:
                // For unknown tones or no tone, just return a slightly modified version
                rephrased = text + '?'; // Simple fallback
        }
    } else {
        // No tone specified - simple rephrase
        rephrased = text + '?';
    }
    
    return rephrased;
}
app.post("/leave-room", async (req, res) => {
  try {
    const { user_email, room_id } = req.body;
    
    const userResult = await pool.query(
      "SELECT matrix_access_token FROM users WHERE email=$1",
      [user_email]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    let accessToken = userResult.rows[0].matrix_access_token;

    try {
      await axios.post(
        `${homeserver}/_matrix/client/v3/rooms/${room_id}/leave`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      await pool.query(
        "DELETE FROM rooms WHERE room_id=$1 AND user_email=$2",
        [room_id, user_email]
      );

      res.json({ success: true, message: "Left room successfully" });
    } catch (error) {
      if (error.response?.status === 401) {
        const newTokens = await refreshToken(user_email);
        if (newTokens) {
          accessToken = newTokens.newAccessToken;
          
          await axios.post(
            `${homeserver}/_matrix/client/v3/rooms/${room_id}/leave`,
            {},
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          res.json({ success: true, message: "Left room successfully" });
        } else {
          throw new Error("Failed to refresh token");
        }
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error("Leave room error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to leave room" });
  }
});

app.post("/api/getRoomHistory", async (req, res) => {
  try {
    const { email, room_id, limit = 100 } = req.body;
    
    const userResult = await pool.query(
      "SELECT matrix_access_token FROM users WHERE email=$1",
      [email]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const accessToken = userResult.rows[0].matrix_access_token;
    
    const fifteenDaysAgo = Date.now() - (15 * 24 * 60 * 60 * 1000);
    
    const messagesResponse = await axios.get(
      `${homeserver}/_matrix/client/v3/rooms/${room_id}/messages?dir=b&limit=${limit}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const messages = messagesResponse.data.chunk
      .filter(event => {
        if (event.type !== "m.room.message" && event.type !== "m.reaction") return false;
        return event.origin_server_ts >= fifteenDaysAgo;
      })
      .map(event => {
        if (event.type === "m.room.message") {
          // Resolve media URLs
          let content = { ...event.content };
          if (content.url && content.url.startsWith('mxc://')) {
            content.fileUrl = resolveMxcUrl(content.url);
            if (content.msgtype === 'm.image' || content.msgtype === 'm.video') {
              content.thumbnailUrl = getThumbnailUrl(content.url, 400, 300);
            }
          }
          
          return {
            event_id: event.event_id,
            sender: event.sender,
            type: event.content.msgtype,
            body: event.content.body,
            timestamp: event.origin_server_ts,
            content: content // Use resolved content
          };
        } else if (event.type === "m.reaction") {
          return {
            event_id: event.event_id,
            sender: event.sender,
            type: "reaction",
            related_event_id: event.content["m.relates_to"]?.event_id,
            reaction_key: event.content["m.relates_to"]?.key,
            timestamp: event.origin_server_ts
          };
        }
      })
      .reverse();

    res.json({ success: true, messages });
  } catch (error) {
    console.error("Get room history error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to get room history" });
  }
});

// Make sure this is BELOW all your routes
if (app && app._router && app._router.stack) {
  console.log("🧭 Registered routes:");
  app._router.stack.forEach((r) => {
    if (r.route && r.route.path) {
      console.log(`➡️ ${r.route.stack[0].method.toUpperCase()} ${r.route.path}`);
    }
  });
} else {
  console.log("⚠️ No routes found or app not initialized yet!");
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Frontend available at: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server ready for real-time messaging`);
  console.log(`🔄 Long-polling sync enabled with 60-second timeouts`);
  console.log(`📱 Platform detection: Enhanced admin-based detection`);
  console.log(`☁️  Cloudinary integration: ${process.env.CLOUDINARY_CLOUD_NAME ? 'Enabled' : 'Disabled'}`);
  console.log(`🤝 Auto-join rooms: Enabled`);
  console.log(`🔗 Media URL resolution: Enabled - MXC URLs will be resolved to HTTP URLs`);
  console.log(`📁 File upload enabled with 50MB limit and 10 files maximum`);
});