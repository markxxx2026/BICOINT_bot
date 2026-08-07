(function () {
  var toggle = document.getElementById('menuToggle');
  var sidebar = document.querySelector('.sidebar');
  var backdrop = document.getElementById('sidebarBackdrop');
  if (!toggle || !sidebar) return;

  function open() {
    sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('show');
  }

  function close() {
    sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('show');
  }

  toggle.addEventListener('click', function (e) {
    e.stopPropagation();
    sidebar.classList.contains('open') ? close() : open();
  });

  if (backdrop) {
    backdrop.addEventListener('click', close);
  }

  sidebar.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      if (window.innerWidth <= 900) close();
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });
})();
