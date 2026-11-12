// Progressive extras. The page works without this file: the buttons it shows start out hidden.
(function () {
  // Close the phone menu after a link in it is chosen (it is a plain <details> without this).
  document.querySelectorAll('details.menu a').forEach(function (a) {
    a.addEventListener('click', function () { a.closest('details').open = false; });
  });

  // Copy buttons (the signing fingerprint).
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    var src = document.getElementById(btn.dataset.copy);
    if (!src || !navigator.clipboard) return;
    btn.hidden = false;
    var label = btn.querySelector('span');
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(src.textContent.trim()).then(
        function () { label.textContent = 'Copied'; setTimeout(function () { label.textContent = 'Copy'; }, 2000); },
        function () { label.textContent = 'Select and copy'; },
      );
    });
  });
})();
