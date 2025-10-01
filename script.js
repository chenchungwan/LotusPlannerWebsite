// Smooth scrolling for navigation links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Navbar background on scroll
window.addEventListener('scroll', () => {
    const navbar = document.querySelector('.navbar');
    if (window.scrollY > 50) {
        navbar.style.background = 'rgba(255, 255, 255, 0.98)';
        navbar.style.boxShadow = '0 2px 20px rgba(0, 0, 0, 0.1)';
    } else {
        navbar.style.background = 'rgba(255, 255, 255, 0.95)';
        navbar.style.boxShadow = 'none';
    }
});

// App Store link tracking (optional analytics)
document.querySelectorAll('a[href*="apps.apple.com"]').forEach(link => {
    link.addEventListener('click', function() {
        // Optional: Track App Store link clicks
        console.log('App Store link clicked');
        
        // Optional: Add analytics tracking here
        // gtag('event', 'click', { event_category: 'App Store', event_label: 'Download' });
    });
});

// Newsletter functionality - now opens Google Form in new window
// No JavaScript needed - handled by HTML link

// Notification system
function showNotification(message, type = 'info') {
    // Remove existing notifications
    const existingNotification = document.querySelector('.notification');
    if (existingNotification) {
        existingNotification.remove();
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <div class="notification-content">
            <span>${message}</span>
            <button class="notification-close">&times;</button>
        </div>
    `;
    
    // Add styles
    const styles = `
        .notification {
            position: fixed;
            top: 100px;
            right: 20px;
            max-width: 400px;
            padding: 1rem;
            border-radius: 0.75rem;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
            z-index: 10000;
            transform: translateX(100%);
            transition: transform 0.3s ease;
        }
        
        .notification-success {
            background: #10b981;
            color: white;
        }
        
        .notification-error {
            background: #ef4444;
            color: white;
        }
        
        .notification-info {
            background: #3b82f6;
            color: white;
        }
        
        .notification-content {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 1rem;
        }
        
        .notification-close {
            background: none;
            border: none;
            color: inherit;
            font-size: 1.5rem;
            cursor: pointer;
            opacity: 0.7;
            transition: opacity 0.2s ease;
        }
        
        .notification-close:hover {
            opacity: 1;
        }
        
        @media (max-width: 480px) {
            .notification {
                right: 10px;
                left: 10px;
                max-width: none;
            }
        }
    `;
    
    // Add styles to head if not already present
    if (!document.querySelector('#notification-styles')) {
        const styleSheet = document.createElement('style');
        styleSheet.id = 'notification-styles';
        styleSheet.textContent = styles;
        document.head.appendChild(styleSheet);
    }
    
    // Add to page
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => {
        notification.style.transform = 'translateX(0)';
    }, 100);
    
    // Close button functionality
    const closeBtn = notification.querySelector('.notification-close');
    closeBtn.addEventListener('click', () => {
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => notification.remove(), 300);
    });
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        if (document.body.contains(notification)) {
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}

// Intersection Observer for animations
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// Observe elements for animation
document.addEventListener('DOMContentLoaded', () => {
    const animatedElements = document.querySelectorAll('.feature-card, .screenshot-card, .about-content');
    
    animatedElements.forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(el);
    });
});

// Demo button functionality - highlight the video
document.querySelector('.btn-secondary').addEventListener('click', function(e) {
    e.preventDefault();
    
    // Scroll to video and add attention effect
    const videoContainer = document.querySelector('.video-container');
    if (videoContainer) {
        videoContainer.scrollIntoView({ 
            behavior: 'smooth', 
            block: 'center' 
        });
        
        // Add a temporary highlight effect
        videoContainer.style.transform = 'scale(1.02)';
        videoContainer.style.transition = 'transform 0.3s ease';
        
        setTimeout(() => {
            videoContainer.style.transform = 'scale(1)';
        }, 1000);
        
        showNotification('Check out the demo video! 👆', 'info');
    }
});

// Simplified Screenshots Carousel
function initCarousel() {
    const carousel = document.querySelector('.screenshots-carousel');
    const cards = document.querySelectorAll('.screenshot-card');
    const prevBtn = document.querySelector('.carousel-prev');
    const nextBtn = document.querySelector('.carousel-next');
    const indicators = document.querySelectorAll('.carousel-indicator');
    
    console.log('Carousel elements found:', {
        carousel: !!carousel,
        cards: cards.length,
        prevBtn: !!prevBtn,
        nextBtn: !!nextBtn,
        indicators: indicators.length
    });
    
    if (!carousel || !cards.length || !prevBtn || !nextBtn) {
        console.error('Carousel elements missing!');
        return;
    }
    
    let currentSlide = 0;
    
    function updateCarousel() {
        const translateX = -currentSlide * 100;
        console.log(`Moving to slide ${currentSlide}, translateX: ${translateX}%`);
        carousel.style.transform = `translateX(${translateX}%)`;
        
        // Update indicators
        indicators.forEach((indicator, index) => {
            indicator.classList.toggle('active', index === currentSlide);
        });
        
        // Update navigation buttons
        prevBtn.disabled = currentSlide === 0;
        nextBtn.disabled = currentSlide === cards.length - 1;
    }
    
    function nextSlide() {
        if (currentSlide < cards.length - 1) {
            currentSlide++;
            updateCarousel();
        }
    }
    
    function previousSlide() {
        if (currentSlide > 0) {
            currentSlide--;
            updateCarousel();
        }
    }
    
    function goToSlide(index) {
        if (index >= 0 && index < cards.length) {
            currentSlide = index;
            updateCarousel();
        }
    }
    
    // Event listeners
    prevBtn.addEventListener('click', () => {
        console.log('Previous button clicked');
        previousSlide();
    });
    
    nextBtn.addEventListener('click', () => {
        console.log('Next button clicked');
        nextSlide();
    });
    
    indicators.forEach((indicator, index) => {
        indicator.addEventListener('click', () => {
            console.log(`Indicator ${index} clicked`);
            goToSlide(index);
        });
    });
    
    // Initialize
    updateCarousel();
    console.log('Carousel initialized successfully');
}
    
    nextSlide() {
        this.currentSlide = (this.currentSlide + 1) % this.cards.length;
        this.updateCarousel();
    }
    
    previousSlide() {
        this.currentSlide = (this.currentSlide - 1 + this.cards.length) % this.cards.length;
        this.updateCarousel();
    }
    
    goToSlide(index) {
        this.currentSlide = index;
        this.updateCarousel();
    }
    
    updateCarousel() {
        // Move carousel
        const translateX = -this.currentSlide * 100;
        console.log(`Moving to slide ${this.currentSlide}, translateX: ${translateX}%`);
        this.carousel.style.transform = `translateX(${translateX}%)`;
        
        // Update indicators
        this.indicators.forEach((indicator, index) => {
            indicator.classList.toggle('active', index === this.currentSlide);
        });
        
        // Update navigation buttons
        this.prevBtn.disabled = this.currentSlide === 0;
        this.nextBtn.disabled = this.currentSlide === this.cards.length - 1;
        
        console.log(`Carousel updated - Current slide: ${this.currentSlide}`);
    }
    
    setupTouchEvents() {
        let startX = 0;
        let currentX = 0;
        let isDragging = false;
        
        this.carousel.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            isDragging = true;
        });
        
        this.carousel.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            currentX = e.touches[0].clientX;
        });
        
        this.carousel.addEventListener('touchend', () => {
            if (!isDragging) return;
            isDragging = false;
            
            const deltaX = startX - currentX;
            const threshold = 50;
            
            if (Math.abs(deltaX) > threshold) {
                if (deltaX > 0) {
                    this.nextSlide();
                } else {
                    this.previousSlide();
                }
            }
        });
        
        // Mouse drag support for desktop
        let isMouseDown = false;
        
        this.carousel.addEventListener('mousedown', (e) => {
            startX = e.clientX;
            isMouseDown = true;
            this.carousel.style.cursor = 'grabbing';
        });
        
        this.carousel.addEventListener('mousemove', (e) => {
            if (!isMouseDown) return;
            e.preventDefault();
            currentX = e.clientX;
        });
        
        this.carousel.addEventListener('mouseup', () => {
            if (!isMouseDown) return;
            isMouseDown = false;
            this.carousel.style.cursor = 'grab';
            
            const deltaX = startX - currentX;
            const threshold = 50;
            
            if (Math.abs(deltaX) > threshold) {
                if (deltaX > 0) {
                    this.nextSlide();
                } else {
                    this.previousSlide();
                }
            }
        });
        
        this.carousel.addEventListener('mouseleave', () => {
            isMouseDown = false;
            this.carousel.style.cursor = 'grab';
        });
    }
    
    startAutoPlay(interval = 5000) {
        setInterval(() => {
            this.nextSlide();
        }, interval);
    }
}

// Consolidated DOM initialization
document.addEventListener('DOMContentLoaded', () => {
    // Initialize carousel
    setTimeout(() => {
        const carousel = new ScreenshotsCarousel();
        console.log('Screenshots carousel initialized:', carousel);
    }, 100);
    
    // Add interactive hover effects
    // iPad mockup interaction
    const ipadMockup = document.querySelector('.ipad-mockup');
    if (ipadMockup) {
        // Add subtle animations to task items
        const taskItems = document.querySelectorAll('.task-item');
        taskItems.forEach((item, index) => {
            item.style.animationDelay = `${index * 0.1}s`;
            item.style.animation = 'fadeInUp 0.6s ease-out forwards';
        });
        
        // Add hover effect to logs
        const logItems = document.querySelectorAll('.log-item');
        logItems.forEach(item => {
            item.addEventListener('mouseenter', () => {
                item.style.transform = 'scale(1.02)';
                item.style.transition = 'transform 0.2s ease';
            });
            
            item.addEventListener('mouseleave', () => {
                item.style.transform = 'scale(1)';
            });
        });
    }
    
    // Feature cards interaction
    document.querySelectorAll('.feature-card').forEach(card => {
        card.addEventListener('mouseenter', () => {
            const icon = card.querySelector('.feature-icon');
            if (icon) {
                icon.style.transform = 'scale(1.2) rotate(5deg)';
                icon.style.transition = 'transform 0.3s ease';
            }
        });
        
        card.addEventListener('mouseleave', () => {
            const icon = card.querySelector('.feature-icon');
            if (icon) {
                icon.style.transform = 'scale(1) rotate(0deg)';
            }
        });
    });
});

// Console message for developers
console.log(`
🪷 Lotus Planner Landing Page
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Thanks for checking out the code! 
This landing page was built with vanilla HTML, CSS, and JavaScript.

Interested in contributing or have feedback?
Contact: hello@lotusplanner.com

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

// Add keyboard navigation support
document.addEventListener('keydown', (e) => {
    // Close notification with Escape key
    if (e.key === 'Escape') {
        const notification = document.querySelector('.notification');
        if (notification) {
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => notification.remove(), 300);
        }
    }
    
    // App Store links can be opened with Enter key when focused
    if (e.key === 'Enter' && document.activeElement.href && document.activeElement.href.includes('apps.apple.com')) {
        document.activeElement.click();
    }
    
    // Newsletter link can be opened with Enter key when focused
    if (e.key === 'Enter' && document.activeElement.classList.contains('newsletter-link')) {
        document.activeElement.click();
    }
});
