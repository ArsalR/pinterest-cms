/* Clears the cart on the order-success page (the second, tiny allowed island).
   Purely local; no network, no tracking. */
try { localStorage.removeItem("sn_cart"); } catch (e) {}
