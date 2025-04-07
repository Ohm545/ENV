import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// File upload configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Serve static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Database connection
const pool = new pg.Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'ecosocial',
  password: process.env.DB_PASSWORD || 'postgres',
  port: process.env.DB_PORT || 5432,
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    req.user = user;
    next();
  });
};

// Routes

// Auth routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    // Check if user already exists
    const userExists = await pool.query(
      'SELECT * FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const result = await pool.query(
      'INSERT INTO users (username, email, password, name, bio, avatar, eco_credits, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id, username, email, name, bio, avatar, eco_credits',
      [username, email, hashedPassword, username, '', 'https://via.placeholder.com/100', 0]
    );
    
    const user = result.rows[0];
    
    // Generate token
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    
    res.status(201).json({ token, user });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Find user
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    
    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Generate token
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    
    // Remove password from user object
    delete user.password;
    
    res.json({ token, user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// User routes
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user data
    const userResult = await pool.query(
      'SELECT id, username, email, name, bio, avatar, eco_credits FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // Get counts
    const postsCountResult = await pool.query(
      'SELECT COUNT(*) FROM posts WHERE user_id = $1',
      [userId]
    );
    
    const followersCountResult = await pool.query(
      'SELECT COUNT(*) FROM followers WHERE followed_id = $1',
      [userId]
    );
    
    const followingCountResult = await pool.query(
      'SELECT COUNT(*) FROM followers WHERE follower_id = $1',
      [userId]
    );
    
    // Get impacts
    const impactsResult = await pool.query(
      'SELECT * FROM impacts WHERE user_id = $1',
      [userId]
    );
    
    // Format response
    const response = {
      ...user,
      postsCount: parseInt(postsCountResult.rows[0].count),
      followersCount: parseInt(followersCountResult.rows[0].count),
      followingCount: parseInt(followingCountResult.rows[0].count),
      impacts: impactsResult.rows.map(impact => ({
        id: impact.id,
        title: impact.title,
        value: impact.value,
        icon: impact.icon
      }))
    };
    
    res.json(response);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Stories routes
app.get('/api/stories', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.media_url, s.created_at, s.expires_at,
             u.id as user_id, u.username, u.avatar
      FROM stories s
      JOIN users u ON s.user_id = u.id
      WHERE s.expires_at > NOW()
      ORDER BY s.created_at DESC
    `);
    
    const stories = result.rows.map(row => ({
      id: row.id,
      mediaUrl: row.media_url,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      user: {
        id: row.user_id,
        username: row.username,
        avatar: row.avatar
      }
    }));
    
    res.json(stories);
  } catch (error) {
    console.error('Get stories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/stories', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    const userId = req.user.id;
    const mediaUrl = `/uploads/${req.file.filename}`;
    const type = req.body.type || 'image';
    
    // Stories expire after 24 hours
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    
    const result = await pool.query(
      'INSERT INTO stories (user_id, media_url, type, created_at, expires_at) VALUES ($1, $2, $3, NOW(), $4) RETURNING id',
      [userId, mediaUrl, type, expiresAt]
    );
    
    res.status(201).json({
      id: result.rows[0].id,
      mediaUrl,
      type,
      expiresAt
    });
  } catch (error) {
    console.error('Create story error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Posts routes
app.get('/api/posts', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await pool.query(`
      SELECT p.id, p.caption, p.media_url, p.created_at,
             u.id as user_id, u.username, u.avatar,
             COUNT(DISTINCT l.id) as likes_count,
             EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) as liked,
             i.id as impact_id, i.type as impact_type, i.credits as impact_credits
      FROM posts p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN likes l ON p.id = l.post_id
      LEFT JOIN impacts i ON p.impact_id = i.id
      GROUP BY p.id, u.id, i.id
      ORDER BY p.created_at DESC
    `, [userId]);
    
    // Get comments for each post
    const posts = await Promise.all(result.rows.map(async (row) => {
      const commentsResult = await pool.query(`
        SELECT c.id, c.text, c.created_at,
               u.id as user_id, u.username, u.avatar
        FROM comments c
        JOIN users u ON c.user_id = u.id
        WHERE c.post_id = $1
        ORDER BY c.created_at DESC
        LIMIT 5
      `, [row.id]);
      
      const comments = commentsResult.rows.map(comment => ({
        id: comment.id,
        text: comment.text,
        createdAt: comment.created_at,
        user: {
          id: comment.user_id,
          username: comment.username,
          avatar: comment.avatar
        }
      }));
      
      return {
        id: row.id,
        caption: row.caption,
        mediaUrl: row.media_url,
        createdAt: row.created_at,
        user: {
          id: row.user_id,
          username: row.username,
          avatar: row.avatar
        },
        likesCount: parseInt(row.likes_count),
        liked: row.liked,
        impact: row.impact_id ? {
          id: row.impact_id,
          type: row.impact_type,
          credits: row.impact_credits
        } : null,
        comments
      };
    }));
    
    res.json(posts);
  } catch (error) {
    console.error('Get posts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/posts', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    const userId = req.user.id;
    const caption = req.body.caption || '';
    const mediaUrl = `/uploads/${req.file.filename}`;
    const tags = req.body.tags ? JSON.parse(req.body.tags) : [];
    
    // Start a transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create impact
      const impactResult = await client.query(
        'INSERT INTO impacts (user_id, type, credits, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id',
        [userId, 'forest', 0]
      );
      
      const impactId = impactResult.rows[0].id;
      
      // Create post
      const postResult = await client.query(
        'INSERT INTO posts (user_id, caption, media_url, impact_id, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
        [userId, caption, mediaUrl, impactId]
      );
      
      const postId = postResult.rows[0].id;
      
      // Add tags
      for (const tag of tags) {
        // Check if tag exists
        const tagResult = await client.query(
          'SELECT id FROM tags WHERE name = $1',
          [tag]
        );
        
        let tagId;
        
        if (tagResult.rows.length === 0) {
          // Create tag
          const newTagResult = await client.query(
            'INSERT INTO tags (name, created_at) VALUES ($1, NOW()) RETURNING id',
            [tag]
          );
          
          tagId = newTagResult.rows[0].id;
        } else {
          tagId = tagResult.rows[0].id;
        }
        
        // Add post_tag relation
        await client.query(
          'INSERT INTO post_tags (post_id, tag_id) VALUES ($1, $2)',
          [postId, tagId]
        );
      }
      
      await client.query('COMMIT');
      
      res.status(201).json({
        id: postId,
        caption,
        mediaUrl,
        tags,
        impact: {
          id: impactId,
          type: 'forest',
          credits: 0
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/posts/:id/like', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = req.params.id;
    
    // Check if already liked
    const likeExists = await pool.query(
      'SELECT id FROM likes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );
    
    if (likeExists.rows.length > 0) {
      return res.status(400).json({ error: 'Already liked' });
    }
    
    // Add like
    await pool.query(
      'INSERT INTO likes (user_id, post_id, created_at) VALUES ($1, $2, NOW())',
      [userId, postId]
    );
    
    // Get updated like count
    const likesCountResult = await pool.query(
      'SELECT COUNT(*) FROM likes WHERE post_id = $1',
      [postId]
    );
    
    // Update impact credits
    await pool.query(`
      UPDATE impacts i
      SET credits = credits + 5
      FROM posts p
      WHERE p.impact_id = i.id AND p.id = $1
    `, [postId]);
    
    // Update user eco credits
    await pool.query(`
      UPDATE users u
      SET eco_credits = eco_credits + 5
      FROM posts p
      WHERE p.user_id = u.id AND p.id = $1
    `, [postId]);
    
    res.json({
      liked: true,
      likesCount: parseInt(likesCountResult.rows[0].count)
    });
  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/posts/:id/like', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = req.params.id;
    
    // Remove like
    await pool.query(
      'DELETE FROM likes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );
    
    // Get updated like count
    const likesCountResult = await pool.query(
      'SELECT COUNT(*) FROM likes WHERE post_id = $1',
      [postId]
    );
    
    // Update impact credits
    await pool.query(`
      UPDATE impacts i
      SET credits = GREATEST(0, credits - 5)
      FROM posts p
      WHERE p.impact_id = i.id AND p.id = $1
    `, [postId]);
    
    // Update user eco credits
    await pool.query(`
      UPDATE users u
      SET eco_credits = GREATEST(0, eco_credits - 5)
      FROM posts p
      WHERE p.user_id = u.id AND p.id = $1
    `, [postId]);
    
    res.json({
      liked: false,
      likesCount: parseInt(likesCountResult.rows[0].count)
    });
  } catch (error) {
    console.error('Unlike post error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/posts/:id/comments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = req.params.id;
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Comment text is required' });
    }
    
    // Add comment
    const result = await pool.query(
      'INSERT INTO comments (user_id, post_id, text, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id, text, created_at',
      [userId, postId, text]
    );
    
    const comment = result.rows[0];
    
    // Update impact credits
    await pool.query(`
      UPDATE impacts i
      SET credits = credits + 2
      FROM posts p
      WHERE p.impact_id = i.id AND p.id = $1
    `, [postId]);
    
    // Update user eco credits
    await pool.query(`
      UPDATE users u
      SET eco_credits = eco_credits + 2
      FROM posts p
      WHERE p.user_id = u.id AND p.id = $1
    `, [postId]);
    
    res.status(201).json({
      id: comment.id,
      text: comment.text,
      createdAt: comment.created_at,
      user: {
        id: userId,
        username: req.user.username
      }
    });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reels routes
app.get('/api/reels', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await pool.query(`
      SELECT r.id, r.caption, r.media_url, r.created_at,
             u.id as user_id, u.username, u.avatar,
             COUNT(DISTINCT l.id) as likes_count,
             EXISTS(SELECT 1 FROM likes l WHERE l.reel_id = r.id AND l.user_id = $1) as liked,
             i.id as impact_id, i.type as impact_type, i.credits as impact_credits
      FROM reels r
      JOIN users u ON r.user_id = u.id
      LEFT JOIN likes l ON r.id = l.reel_id
      LEFT JOIN impacts i ON r.impact_id = i.id
      GROUP BY r.id, u.id, i.id
      ORDER BY r.created_at DESC
    `, [userId]);
    
    // Get comments for each reel
    const reels = await Promise.all(result.rows.map(async (row) => {
      const commentsResult = await pool.query(`
        SELECT c.id, c.text, c.created_at,
               u.id as user_id, u.username, u.avatar
        FROM comments c
        JOIN users u ON c.user_id = u.id
        WHERE c.reel_id = $1
        ORDER BY c.created_at DESC
        LIMIT 5
      `, [row.id]);
      
      const comments = commentsResult.rows.map(comment => ({
        id: comment.id,
        text: comment.text,
        createdAt: comment.created_at,
        user: {
          id: comment.user_id,
          username: comment.username,
          avatar: comment.avatar
        }
      }));
      
      return {
        id: row.id,
        caption: row.caption,
        mediaUrl: row.media_url,
        createdAt: row.created_at,
        user: {
          id: row.user_id,
          username: row.username,
          avatar: row.avatar
        },
        likesCount: parseInt(row.likes_count),
        liked: row.liked,
        impact: row.impact_id ? {
          id: row.impact_id,
          type: row.impact_type,
          credits: row.impact_credits
        } : null,
        comments
      };
    }));
    
    res.json(reels);
  } catch (error) {
    console.error('Get reels error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/reels', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    const userId = req.user.id;
    const caption = req.body.caption || '';
    const mediaUrl = `/uploads/${req.file.filename}`;
    const tags = req.body.tags ? JSON.parse(req.body.tags) : [];
    
    // Start a transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create impact
      const impactResult = await client.query(
        'INSERT INTO impacts (user_id, type, credits, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id',
        [userId, 'air', 0]
      );
      
      const impactId = impactResult.rows[0].id;
      
      // Create reel
      const reelResult = await client.query(
        'INSERT INTO reels (user_id, caption, media_url, impact_id, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
        [userId, caption, mediaUrl, impactId]
      );
      
      const reelId = reelResult.rows[0].id;
      
      // Add tags
      for (const tag of tags) {
        // Check if tag exists
        const tagResult = await client.query(
          'SELECT id FROM tags WHERE name = $1',
          [tag]
        );
        
        let tagId;
        
        if (tagResult.rows.length === 0) {
          // Create tag
          const newTagResult = await client.query(
            'INSERT INTO tags (name, created_at) VALUES ($1, NOW()) RETURNING id',
            [tag]
          );
          
          tagId = newTagResult.rows[0].id;
        } else {
          tagId = tagResult.rows[0].id;
        }
        
        // Add reel_tag relation
        await client.query(
          'INSERT INTO reel_tags (reel_id, tag_id) VALUES ($1, $2)',
          [reelId, tagId]
        );
      }
      
      await client.query('COMMIT');
      
      res.status(201).json({
        id: reelId,
        caption,
        mediaUrl,
        tags,
        impact: {
          id: impactId,
          type: 'air',
          credits: 0
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Create reel error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/reels/:id/like', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const reelId = req.params.id;
    
    // Check if already liked
    const likeExists = await pool.query(
      'SELECT id FROM likes WHERE user_id = $1 AND reel_id = $2',
      [userId, reelId]
    );
    
    if (likeExists.rows.length > 0) {
      return res.status(400).json({ error: 'Already liked' });
    }
    
    // Add like
    await pool.query(
      'INSERT INTO likes (user_id, reel_id, created_at) VALUES ($1, $2, NOW())',
      [userId, reelId]
    );
    
    // Get updated like count
    const likesCountResult = await pool.query(
      'SELECT COUNT(*) FROM likes WHERE reel_id = $1',
      [reelId]
    );
    
    // Update impact credits
    await pool.query(`
      UPDATE impacts i
      SET credits = credits + 5
      FROM reels r
      WHERE r.impact_id = i.id AND r.id = $1
    `, [reelId]);
    
    // Update user eco credits
    await pool.query(`
      UPDATE users u
      SET eco_credits = eco_credits + 5
      FROM reels r
      WHERE r.user_id = u.id AND r.id = $1
    `, [reelId]);
    
    res.json({
      liked: true,
      likesCount: parseInt(likesCountResult.rows[0].count)
    });
  } catch (error) {
    console.error('Like reel error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/reels/:id/like', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const reelId = req.params.id;
    
    // Remove like
    await pool.query(
      'DELETE FROM likes WHERE user_id = $1 AND reel_id = $2',
      [userId, reelId]
    );
    
    // Get updated like count
    const likesCountResult = await pool.query(
      'SELECT COUNT(*) FROM likes WHERE reel_id = $1',
      [reelId]
    );
    
    // Update impact credits
    await pool.query(`
      UPDATE impacts i
      SET credits = GREATEST(0, credits - 5)
      FROM reels r
      WHERE r.impact_id = i.id AND r.id = $1
    `, [reelId]);
    
    // Update user eco credits
    await pool.query(`
      UPDATE users u
      SET eco_credits = GREATEST(0, eco_credits - 5)
      FROM reels r
      WHERE r.user_id = u.id AND r.id = $1
    `, [reelId]);
    
    res.json({
      liked: false,
      likesCount: parseInt(likesCountResult.rows[0].count)
    });
  } catch (error) {
    console.error('Unlike reel error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/reels/:id/comments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const reelId = req.params.id;
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Comment text is required' });
    }
    
    // Add comment
    const result = await pool.query(
      'INSERT INTO comments (user_id, reel_id, text, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id, text, created_at',
      [userId, reelId, text]
    );
    
    const comment = result.rows[0];
    
    // Update impact credits
    await pool.query(`
      UPDATE impacts i
      SET credits = credits + 2
      FROM reels r
      WHERE r.impact_id = i.id AND r.id = $1
    `, [reelId]);
    
    // Update user eco credits
    await pool.query(`
      UPDATE users u
      SET eco_credits = eco_credits + 2
      FROM reels r
      WHERE r.user_id = u.id AND r.id = $1
    `, [reelId]);
    
    res.status(201).json({
      id: comment.id,
      text: comment.text,
      createdAt: comment.created_at,
      user: {
        id: userId,
        username: req.user.username
      }
    });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Tags routes
app.get('/api/tags', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.name, COUNT(pt.post_id) + COUNT(rt.reel_id) as usage_count
      FROM tags t
      LEFT JOIN post_tags pt ON t.id = pt.tag_id
      LEFT JOIN reel_tags rt ON t.id = rt.tag_id
      GROUP BY t.id
      ORDER BY usage_count DESC
      LIMIT 20
    `);
    
    const tags = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      usageCount: parseInt(row.usage_count)
    }));
    
    res.json(tags);
  } catch (error) {
    console.error('Get tags error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Quotes routes
app.get('/api/quotes', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, text, author
      FROM quotes
      ORDER BY RANDOM()
      LIMIT 5
    `);
    
    const quotes = result.rows.map(row => ({
      id: row.id,
      text: row.text,
      author: row.author
    }));
    
    res.json(quotes);
  } catch (error) {
    console.error('Get quotes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});