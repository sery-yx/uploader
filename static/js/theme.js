// Runs in <head> before first paint so the page never flashes the wrong theme. Dark is the default.
(function () {
  var root = document.documentElement;
  try {
    if (localStorage.getItem('cyexTheme') === 'light') root.dataset.theme = 'light';
  } catch (e) {}
  root.classList.add('js');
  if (root.dataset.theme === 'light') {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = '#f3f3f4';
  }
})();
