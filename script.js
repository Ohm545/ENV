document.addEventListener('DOMContentLoaded', function() {
    // Tab switching
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.getAttribute('data-tab');
        
        // Update active tab button
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // Show corresponding tab content
        tabContents.forEach(content => {
          content.classList.remove('active');
          if (content.id === `${tabName}-content`) {
            content.classList.add('active');
          }
        });
      });
    });
    
    // Like functionality
    const likeButtons = document.querySelectorAll('[data-action="like"]');
    likeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const isActive = btn.classList.contains('active');
        const countEl = btn.nextElementSibling;
        let count = parseInt(countEl.textContent);
        
        if (isActive) {
          btn.classList.remove('active');
          btn.querySelector('i').classList.remove('fa-solid');
          btn.querySelector('i').classList.add('fa-regular');
          countEl.textContent = count - 1;
        } else {
          btn.classList.add('active');
          btn.querySelector('i').classList.remove('fa-regular');
          btn.querySelector('i').classList.add('fa-solid');
          countEl.textContent = count + 1;
        }
      });
    });
    
    // Save functionality
    const saveButtons = document.querySelectorAll('[data-action="save"]');
    saveButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const isActive = btn.classList.contains('active');
        
        if (isActive) {
          btn.classList.remove('active');
          btn.querySelector('i').classList.remove('fa-solid');
          btn.querySelector('i').classList.add('fa-regular');
        } else {
          btn.classList.add('active');
          btn.querySelector('i').classList.remove('fa-regular');
          btn.querySelector('i').classList.add('fa-solid');
        }
      });
    });
    
    // Sidebar navigation
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        navItems.forEach(i => i.classList.remove('active'));
        item.classList.add('active');
      });
    });
    
    // Mobile navigation
    const mobileNavItems = document.querySelectorAll('.mobile-nav .nav-item');
    mobileNavItems.forEach(item => {
      item.addEventListener('click', () => {
        mobileNavItems.forEach(i => i.classList.remove('active'));
        item.classList.add('active');
      });
    });
    
    // Reel navigation
    const prevBtn = document.querySelector('.prev-btn');
    const nextBtn = document.querySelector('.next-btn');
    let currentReelIndex = 0;
    const totalReels = 3; // Update this based on your actual number of reels
    
    if (prevBtn && nextBtn) {
      prevBtn.addEventListener('click', () => {
        if (currentReelIndex > 0) {
          currentReelIndex--;
          updateReelNavigation();
          // Here you would update the reel content
        }
      });
      
      nextBtn.addEventListener('click', () => {
        if (currentReelIndex < totalReels - 1) {
          currentReelIndex++;
          updateReelNavigation();
          // Here you would update the reel content
        }
      });
      
      function updateReelNavigation() {
        prevBtn.disabled = currentReelIndex === 0;
        nextBtn.disabled = currentReelIndex === totalReels - 1;
      }
    }
    
    // Comments panel toggle
    const commentsToggle = document.getElementById('comments-toggle');
    const commentsPanel = document.querySelector('.comments-panel');
    const closeBtn = document.querySelector('.close-btn');
    
    if (commentsToggle && commentsPanel && closeBtn) {
      commentsToggle.addEventListener('click', () => {
        commentsPanel.classList.remove('hidden');
      });
      
      closeBtn.addEventListener('click', () => {
        commentsPanel.classList.add('hidden');
      });
    }
    
    // Dark mode toggle (example - you can add a button for this)
    function toggleDarkMode() {
      document.body.classList.toggle('dark');
    }
    
    // Environmental animations
    function addEnvironmentalAnimations() {
      // Add leaf sway animation to leaf icons
      const leafIcons = document.querySelectorAll('.fa-leaf');
      leafIcons.forEach(icon => {
        icon.classList.add('leaf-sway');
      });
      
      // Add water ripple effect to water-related elements
      const waterIcons = document.querySelectorAll('.fa-droplet');
      waterIcons.forEach(icon => {
        icon.classList.add('water-ripple');
      });
    }
    
    addEnvironmentalAnimations();
    
    // Post creation functionality (placeholder)
    function setupPostCreation() {
      const createBtn = document.querySelector('.create-btn');
      if (createBtn) {
        createBtn.addEventListener('click', () => {
          // This would open a modal or navigate to post creation page
          console.log('Create post clicked');
        });
      }
    }
    
    setupPostCreation();
    
    // Environmental impact tracking (simulated)
    function simulateImpactTracking() {
      // This would be connected to a backend in a real app
      const impactCards = document.querySelectorAll('.impact-card');
      
      // Simulate real-time updates
      setInterval(() => {
        impactCards.forEach(card => {
          const progressBar = card.querySelector('.progress-bar');
          const impactText = card.querySelector('.impact-text');
          
          if (progressBar && impactText) {
            // Get current width and credits
            const currentWidth = parseFloat(progressBar.style.width);
            const creditMatch = impactText.textContent.match(/(\d+)/);
            
            if (creditMatch) {
              let credits = parseInt(creditMatch[0]);
              
              // Randomly increase credits (simulation)
              if (Math.random() > 0.7) {
                credits += 1;
                const newWidth = Math.min(100, credits / 2) + '%';
                
                // Update the UI
                progressBar.style.width = newWidth;
                impactText.textContent = impactText.textContent.replace(/\d+/, credits);
                
                // Add a subtle highlight effect
                card.style.boxShadow = '0 0 10px rgba(34, 197, 94, 0.5)';
                setTimeout(() => {
                  card.style.boxShadow = '';
                }, 1000);
              }
            }
          }
        });
      }, 5000); // Check every 5 seconds
    }
    
    simulateImpactTracking();
    
    // Responsive search functionality
    function setupResponsiveSearch() {
      const mobileSearchBtn = document.querySelector('.mobile-search-btn');
      
      if (mobileSearchBtn) {
        mobileSearchBtn.addEventListener('click', () => {
          // This would show a mobile search overlay
          alert('Search functionality would appear here on mobile');
        });
      }
    }
    
    setupResponsiveSearch();
  });