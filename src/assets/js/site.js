/* Accessrank — shared site behaviour. No framework, no dependencies. */
(function () {
  'use strict';

  /* ------------------------------------------------------ mobile nav --- */

  var toggle = document.querySelector('.nav-toggle');
  var menu = document.getElementById('nav-menu');

  if (toggle && menu) {
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.classList.toggle('is-open', open);
      document.body.classList.toggle('nav-open', open);
    };

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    // Escape closes the menu and returns focus to the control that opened it.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });

    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });

    // Leaving the mobile breakpoint must not strand the menu in an open state.
    var mq = window.matchMedia('(min-width: 861px)');
    var onChange = function (event) { if (event.matches) setOpen(false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ------------------------------------------------- pricing toggle ---- */

  var priceToggle = document.getElementById('price-toggle');
  var pricing = document.querySelector('.pricing');

  if (priceToggle && pricing) {
    var buttons = priceToggle.querySelectorAll('[data-mode]');

    var applyMode = function (mode) {
      pricing.setAttribute('data-mode', mode);

      buttons.forEach(function (button) {
        var active = button.getAttribute('data-mode') === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });

      pricing.querySelectorAll('[data-onetime]').forEach(function (el) {
        var full = Number(el.getAttribute('data-onetime'));
        if (!full) return;
        // IRS Form 8826: 50% of eligible expenses over $250, capped at $5,000.
        var credit = Math.min(0.5 * Math.max(full - 250, 0), 5000);
        var net = Math.round(full - credit);
        el.textContent = '$' + (mode === 'credit' ? net : full).toLocaleString('en-US');
      });

      pricing.querySelectorAll('[data-was]').forEach(function (el) {
        el.hidden = mode !== 'credit';
      });
    };

    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        applyMode(button.getAttribute('data-mode'));
      });
    });

    applyMode('standard');
  }

  /* ------------------------------------------------ smooth anchors ----- */

  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href^="#"], a[href^="/#"]');
    if (!link) return;

    var hash = link.getAttribute('href').replace(/^\//, '');
    if (hash === '#' || hash.length < 2) return;

    var target = document.querySelector(hash);
    if (!target) return; // let the browser navigate to the other page

    e.preventDefault();
    target.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start'
    });

    // scrollIntoView does not move focus, which strands keyboard and screen
    // reader users at the top of the document.
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    history.replaceState(null, '', hash);
  });

  /* --------------------------------------------------- lead forms ------ */

  document.querySelectorAll('form[data-lead-form]').forEach(function (form) {
    var status = form.querySelector('[data-form-status]');
    var submit = form.querySelector('[type="submit"]');
    var loadedAt = form.querySelector('[name="formLoadedAt"]');
    if (loadedAt) loadedAt.value = String(Date.now());

    // Prefill from the query string so /signup?plan=growth lands on the right plan.
    var params = new URLSearchParams(location.search);
    ['plan', 'intent'].forEach(function (key) {
      var value = params.get(key);
      if (!value) return;
      var field = form.querySelector('[name="' + key + '"]');
      if (field) field.value = value;
      var pill = document.querySelector('[data-plan-pill]');
      if (key === 'plan' && pill) pill.textContent = value.charAt(0).toUpperCase() + value.slice(1);
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.dataset.busy === '1') return;

      form.dataset.busy = '1';
      if (submit) { submit.disabled = true; submit.dataset.label = submit.textContent; submit.textContent = 'Sending…'; }
      if (status) { status.textContent = ''; status.className = 'form-status'; }
      form.querySelectorAll('.field-error').forEach(function (el) { el.remove(); });
      form.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });

      var payload = {};
      new FormData(form).forEach(function (value, key) { payload[key] = value; });
      payload.consent = form.querySelector('[name="consent"]') ? form.querySelector('[name="consent"]').checked : true;
      payload.marketingOptIn = form.querySelector('[name="marketingOptIn"]')
        ? form.querySelector('[name="marketingOptIn"]').checked : false;

      var token = form.querySelector('[name="cf-turnstile-response"]');
      if (token) payload.turnstileToken = token.value;

      window.Accessrank.post('/api/lead', payload).then(function (data) {
        var success = form.parentElement.querySelector('[data-form-success]');
        if (success) {
          form.hidden = true;
          success.hidden = false;
          success.setAttribute('tabindex', '-1');
          success.focus();
        } else if (status) {
          status.textContent = 'Thanks — we will be in touch shortly.';
          status.className = 'form-status is-success';
        }
        return data;
      }).catch(function (err) {
        if (status) {
          status.textContent = err.message;
          status.className = 'form-status is-error';
        }
        if (err.field) {
          var field = form.querySelector('[name="' + err.field + '"]');
          if (field) {
            field.setAttribute('aria-invalid', 'true');
            field.focus();
          }
        }
        if (window.turnstile) window.turnstile.reset();
      }).finally(function () {
        form.dataset.busy = '0';
        if (submit) { submit.disabled = false; submit.textContent = submit.dataset.label || 'Send'; }
      });
    });
  });

  /* --------------------------------------------------------- shared ---- */

  window.Accessrank = window.Accessrank || {};

  /** POST JSON and turn a non-2xx response into a rejected Error carrying `code`/`field`. */
  window.Accessrank.post = function (path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin'
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.ok && data.ok) return data;
        var error = new Error(data.error || 'Something went wrong. Please try again.');
        error.code = data.code;
        error.field = data.field;
        error.status = response.status;
        error.retryAt = data.retryAt;
        throw error;
      });
    });
  };

  window.Accessrank.reducedMotion = function () {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  };
}());
