(function () {
  const toggle = document.getElementById('theme-toggle');
  const sun    = document.getElementById('icon-sun');
  const moon   = document.getElementById('icon-moon');

  function applyTheme(light) {
    document.body.classList.toggle('light-mode', light);
    if (sun)  sun.style.display  = light ? 'none' : '';
    if (moon) moon.style.display = light ? ''     : 'none';
  }

  applyTheme(localStorage.getItem('theme') === 'light');

  if (toggle) {
    toggle.addEventListener('click', function () {
      const nowLight = !document.body.classList.contains('light-mode');
      localStorage.setItem('theme', nowLight ? 'light' : 'dark');
      applyTheme(nowLight);
    });
  }
})();
