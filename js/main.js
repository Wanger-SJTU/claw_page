/**
 * Custom Theme JavaScript
 */

(function() {
  'use strict';

  // ============================================
  // Theme Toggle (handled by navbar.js)
  // ============================================
  // Theme toggle logic moved to navbar.js to avoid duplicate event listeners

  // ============================================
  // Smooth Scroll for Anchor Links
  // ============================================
  document.querySelectorAll('a[href^="#"]').forEach(function(anchor) {
    anchor.addEventListener('click', function(e) {
      var targetId = this.getAttribute('href');
      if (targetId === '#') return;
      
      var target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      }
    });
  });

  // ============================================
  // Image Lazy Loading (if native not supported)
  // ============================================
  if (!('loading' in HTMLImageElement.prototype)) {
    var images = document.querySelectorAll('img[loading="lazy"]');
    
    if ('IntersectionObserver' in window) {
      var imageObserver = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            var image = entry.target;
            image.src = image.dataset.src || image.src;
            imageObserver.unobserve(image);
          }
        });
      });
      
      images.forEach(function(img) {
        imageObserver.observe(img);
      });
    }
  }

  // ============================================
  // Copy Code Button
  // ============================================
  document.querySelectorAll('pre code').forEach(function(codeBlock) {
    var pre = codeBlock.parentNode;
    
    // Create copy button
    var copyButton = document.createElement('button');
    copyButton.className = 'copy-code-btn';
    copyButton.textContent = '复制';
    copyButton.style.cssText = 'position: absolute; top: 8px; right: 8px; padding: 4px 8px; font-size: 12px; background: var(--color-hover); border: 1px solid var(--color-border); border-radius: 4px; cursor: pointer; opacity: 0; transition: opacity 0.2s;';
    
    // Make pre relative for button positioning
    pre.style.position = 'relative';
    pre.appendChild(copyButton);
    
    // Show button on hover
    pre.addEventListener('mouseenter', function() {
      copyButton.style.opacity = '1';
    });
    
    pre.addEventListener('mouseleave', function() {
      copyButton.style.opacity = '0';
    });
    
    // Copy functionality
    copyButton.addEventListener('click', function() {
      var text = codeBlock.textContent;
      
      navigator.clipboard.writeText(text).then(function() {
        copyButton.textContent = '已复制!';
        setTimeout(function() {
          copyButton.textContent = '复制';
        }, 2000);
      }).catch(function() {
        // Fallback for older browsers
        var textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        
        copyButton.textContent = '已复制!';
        setTimeout(function() {
          copyButton.textContent = '复制';
        }, 2000);
      });
    });
  });

  // ============================================
  // External Links Open in New Tab
  // ============================================
  document.querySelectorAll('a[href^="http"]').forEach(function(link) {
    if (link.hostname !== window.location.hostname) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // ============================================
  // Reading Progress Bar (optional)
  // ============================================
  var progressBar = document.querySelector('.reading-progress');
  
  if (progressBar) {
    window.addEventListener('scroll', function() {
      var scrollTop = window.pageYOffset;
      var docHeight = document.documentElement.scrollHeight - window.innerHeight;
      var progress = (scrollTop / docHeight) * 100;
      progressBar.style.width = progress + '%';
    });
  }

  // ============================================
  // Table of Contents Highlight (optional)
  // ============================================
  var tocLinks = document.querySelectorAll('.toc a');
  var headings = document.querySelectorAll('.post-content h2, .post-content h3');
  
  if (tocLinks.length > 0 && headings.length > 0) {
    var observerOptions = {
      rootMargin: '-10% 0px -85% 0px'
    };
    
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        var id = entry.target.getAttribute('id');
        if (entry.isIntersecting) {
          tocLinks.forEach(function(link) {
            link.classList.remove('active');
            if (link.getAttribute('href') === '#' + id) {
              link.classList.add('active');
            }
          });
        }
      });
    }, observerOptions);
    
    headings.forEach(function(heading) {
      observer.observe(heading);
    });
  }

})();
