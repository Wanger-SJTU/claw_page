/**
 * Navbar - Scroll-aware + Mobile Menu
 */

(function() {
  'use strict';

  // ============================================
  // Scroll-aware Header
  // ============================================
  var header = document.getElementById('site-header');
  var scrollThreshold = 8;

  if (header) {
    function updateHeader() {
      var scrolled = window.pageYOffset || document.documentElement.scrollTop;
      
      if (scrolled > scrollThreshold) {
        header.classList.add('scrolled');
      } else {
        header.classList.remove('scrolled');
      }
    }

    // Initial check
    updateHeader();

    // Listen to scroll events
    window.addEventListener('scroll', updateHeader, { passive: true });
  }

  // ============================================
  // Mobile Menu
  // ============================================
  var hamburger = document.querySelector('.hamburger');
  var mobileMenu = document.getElementById('mobile-menu');
  var mobileOverlay = document.getElementById('mobile-overlay');

  if (hamburger && mobileMenu) {
    function toggleMobileMenu() {
      hamburger.classList.toggle('active');
      mobileMenu.classList.toggle('active');
      mobileOverlay.classList.toggle('active');
      document.body.style.overflow = mobileMenu.classList.contains('active') ? 'hidden' : '';
    }

    hamburger.addEventListener('click', toggleMobileMenu);

    if (mobileOverlay) {
      mobileOverlay.addEventListener('click', toggleMobileMenu);
    }

    // Close menu when clicking nav links
    var mobileNavLinks = mobileMenu.querySelectorAll('.mobile-nav-link');
    if (mobileNavLinks && mobileNavLinks.length) {
      mobileNavLinks.forEach(function(link) {
        link.addEventListener('click', function() {
          if (mobileMenu.classList.contains('active')) {
            toggleMobileMenu();
          }
        });
      });
    }
  }

  // ============================================
  // Theme Toggle (Mobile)
  // ============================================
  var themeToggleMobile = document.getElementById('theme-toggle-mobile');

  if (themeToggleMobile) {
    themeToggleMobile.addEventListener('click', function() {
      var currentTheme = document.documentElement.getAttribute('data-theme');
      var newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
      
      // Update button text
      var iconSun = themeToggleMobile.querySelector('.icon-sun');
      var iconMoon = themeToggleMobile.querySelector('.icon-moon');
      if (newTheme === 'dark') {
        iconSun.style.display = 'none';
        iconMoon.style.display = 'inline';
      } else {
        iconSun.style.display = 'inline';
        iconMoon.style.display = 'none';
      }
    });
  }

  // ============================================
  // Search Toggle (Mobile)
  // ============================================
  var searchToggleMobile = document.querySelector('.search-toggle-mobile');
  var searchModal = document.querySelector('.search-modal');

  if (searchToggleMobile && searchModal) {
    searchToggleMobile.addEventListener('click', function() {
      // Close mobile menu first
      if (mobileMenu && mobileMenu.classList.contains('active')) {
        hamburger.classList.remove('active');
        mobileMenu.classList.remove('active');
        mobileOverlay.classList.remove('active');
        document.body.style.overflow = '';
      }
      
      // Open search modal
      searchModal.classList.add('active');
      var searchInput = searchModal.querySelector('.search-input');
      if (searchInput) {
        searchInput.focus();
      }
    });
  }

  // ============================================
  // Theme Toggle (Desktop)
  // ============================================
  var themeToggle = document.getElementById('theme-toggle');

  if (themeToggle) {
    themeToggle.addEventListener('click', function() {
      var currentTheme = document.documentElement.getAttribute('data-theme');
      var newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
    });
  }

  // ============================================
  // Search Toggle (Desktop)
  // ============================================
  var searchToggle = document.getElementById('search-toggle');

  if (searchToggle && searchModal) {
    searchToggle.addEventListener('click', function() {
      searchModal.classList.add('active');
      var searchInput = searchModal.querySelector('.search-input');
      if (searchInput) {
        searchInput.focus();
      }
    });

    searchModal.addEventListener('click', function(e) {
      if (e.target === searchModal) {
        searchModal.classList.remove('active');
      }
    });
  }

  // ============================================
  // Escape key to close modals/menus
  // ============================================
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      // Close mobile menu
      if (mobileMenu && mobileMenu.classList.contains('active')) {
        hamburger.classList.remove('active');
        mobileMenu.classList.remove('active');
        mobileOverlay.classList.remove('active');
        document.body.style.overflow = '';
      }
      
      // Close search modal
      if (searchModal && searchModal.classList.contains('active')) {
        searchModal.classList.remove('active');
      }
    }
  });

})();
