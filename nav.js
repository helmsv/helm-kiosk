// nav.js
(function () {
  const routes = [
  { href: "/", label: "Waiver Start" },
  { href: "/returns.html", label: "Rental Returns" },
  { href: "/tech.html", label: "Pending Liability Waivers" }
];

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    });
    children.forEach((c) => n.appendChild(c));
    return n;
  }

  function open(overlay) { overlay.classList.add("open"); }
  function close(overlay) { overlay.classList.remove("open"); }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = el("button", { class: "helm-nav-btn", type: "button", text: "Menu" });

    const overlay = el("div", { class: "helm-nav-overlay" });
    const drawer = el("div", { class: "helm-nav-drawer" });

    const header = el("div", { class: "helm-nav-row" }, [
      el("div", { class: "helm-nav-title", text: "Navigate" }),
      el("button", { class: "helm-nav-close", type: "button", text: "Close" })
    ]);

    const list = el("div");
    routes.forEach((r) => {
      const a = el("a", { class: "helm-nav-link", href: r.href, text: r.label });
      list.appendChild(a);
    });

    drawer.appendChild(header);
    drawer.appendChild(list);
    overlay.appendChild(drawer);

    btn.addEventListener("click", () => open(overlay));
    header.querySelector(".helm-nav-close").addEventListener("click", () => close(overlay));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(overlay);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(overlay);
    });

    document.body.appendChild(btn);
    document.body.appendChild(overlay);
  });
})();
