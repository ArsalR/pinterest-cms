/* cart.js — the ONE client-side JavaScript island for ecommerce sites
   (amendment 2: "Cart is the ONLY JavaScript island"). Vanilla, no deps.
   Cart lives in localStorage; checkout is a form POST to the platform relay,
   which computes the real price server-side and redirects to Stripe. */
(function () {
  var KEY = "sn_cart";
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
  function write(c) { localStorage.setItem(KEY, JSON.stringify(c)); render(); }
  function count(c) { return c.reduce(function (n, i) { return n + i.qty; }, 0); }
  function total(c) { return c.reduce(function (n, i) { return n + i.priceCents * i.qty; }, 0); }

  function add(item) {
    var c = read();
    var found = c.find(function (i) { return i.id === item.id; });
    if (found) found.qty += 1; else c.push({ id: item.id, title: item.title, priceCents: item.priceCents, currency: item.currency, qty: 1 });
    write(c);
  }
  function setQty(id, qty) {
    var c = read().map(function (i) { return i.id === id ? Object.assign(i, { qty: qty }) : i; }).filter(function (i) { return i.qty > 0; });
    write(c);
  }
  function money(cents, cur) {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: (cur || "usd").toUpperCase() }).format(cents / 100); }
    catch (e) { return (cents / 100).toFixed(2) + " " + (cur || "USD").toUpperCase(); }
  }

  function render() {
    var c = read();
    document.querySelectorAll("[data-cart-count]").forEach(function (el) { el.textContent = String(count(c)); });

    var view = document.querySelector("[data-cart-view]");
    if (view) {
      if (!c.length) { view.innerHTML = "<p>Your cart is empty.</p>"; return; }
      var cur = c[0].currency;
      var rows = c.map(function (i) {
        return '<div class="cart-row" style="display:flex;justify-content:space-between;gap:1rem;padding:.5rem 0;border-bottom:1px solid #eee">' +
          '<span>' + escapeHtml(i.title) + '</span>' +
          '<span><button data-dec="' + attr(i.id) + '" aria-label="Decrease">−</button> ' + i.qty +
          ' <button data-inc="' + attr(i.id) + '" aria-label="Increase">+</button></span>' +
          '<span>' + money(i.priceCents * i.qty, i.currency) + '</span></div>';
      }).join("");
      view.innerHTML = rows +
        '<p style="text-align:right;font-weight:700;margin-top:1rem">Total: ' + money(total(c), cur) + '</p>';
      view.querySelectorAll("[data-inc]").forEach(function (b) { b.addEventListener("click", function () { var id = b.getAttribute("data-inc"); var it = read().find(function (x) { return x.id === id; }); setQty(id, (it ? it.qty : 0) + 1); }); });
      view.querySelectorAll("[data-dec]").forEach(function (b) { b.addEventListener("click", function () { var id = b.getAttribute("data-dec"); var it = read().find(function (x) { return x.id === id; }); setQty(id, (it ? it.qty : 0) - 1); }); });
    }
  }

  function escapeHtml(s) { return String(s).replace(/[<>&"]/g, function (ch) { return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[ch]; }); }
  function attr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-add-to-cart]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        add({
          id: btn.getAttribute("data-id"),
          title: btn.getAttribute("data-title"),
          priceCents: parseInt(btn.getAttribute("data-price"), 10) || 0,
          currency: btn.getAttribute("data-currency") || "usd",
        });
        btn.textContent = "Added ✓";
        setTimeout(function () { btn.textContent = "Add to cart"; }, 1200);
      });
    });

    var form = document.querySelector("[data-checkout-form]");
    if (form) {
      form.addEventListener("submit", function () {
        var field = form.querySelector("[data-cart-items-field]");
        if (field) field.value = JSON.stringify(read().map(function (i) { return { productId: i.id, qty: i.qty }; }));
      });
    }
    render();
  });
})();
