(function (scope) {
  function create(root, options = {}) {
    const doc = root.ownerDocument;
    let active = false;
    let opener = null;
    let savedOverflow = '';
    let backgrounds = [];

    const focus = (node, preventScroll = true) => {
      if (node && node.isConnected && !node.disabled) node.focus({ preventScroll });
    };
    const firstFocus = () => options.initialFocus || root;
    const tabbable = () => Array.from(root.querySelectorAll('a[href],button,input,select,textarea,[tabindex]'))
      .filter(node => !node.disabled && node.tabIndex >= 0 && !node.closest('[inert]') && node.getClientRects().length);

    function onKeyDown(event) {
      if (!active) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (options.onDismiss) options.onDismiss();
        else hide();
      } else if (event.key === 'Tab') {
        const items = tabbable();
        const first = items[0], last = items[items.length - 1];
        if (!first) {
          event.preventDefault();
          focus(firstFocus());
        } else if (!root.contains(doc.activeElement) || (event.shiftKey && doc.activeElement === first)) {
          event.preventDefault();
          focus(event.shiftKey ? last : first, false);
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault();
          focus(first, false);
        }
      }
    }

    function onFocusIn(event) {
      if (active && !root.contains(event.target)) focus(firstFocus());
    }

    function show(trigger) {
      // Participant changes update the open dialog without stealing focus or
      // overwriting the original return target and background state.
      if (active) return;
      opener = trigger || doc.activeElement;
      savedOverflow = doc.documentElement.style.overflow;
      backgrounds = Array.from(root.parentElement.children)
        .filter(node => node !== root && !['SCRIPT', 'STYLE', 'LINK'].includes(node.tagName))
        .map(node => [node, node.inert]);
      for (const [node] of backgrounds) node.inert = true;
      doc.documentElement.style.overflow = 'hidden';
      root.classList.remove('hidden');
      root.classList.add('flex');
      root.setAttribute('aria-hidden', 'false');
      active = true;
      if (options.scrollRegion) options.scrollRegion.scrollTop = 0;
      doc.addEventListener('keydown', onKeyDown, true);
      doc.addEventListener('focusin', onFocusIn, true);
      focus(firstFocus());
    }

    function hide({ restoreFocus = true } = {}) {
      const wasActive = active;
      active = false;
      root.classList.add('hidden');
      root.classList.remove('flex');
      root.setAttribute('aria-hidden', 'true');
      if (!wasActive) return;
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('focusin', onFocusIn, true);
      for (const [node, inert] of backgrounds) node.inert = inert;
      backgrounds = [];
      doc.documentElement.style.overflow = savedOverflow;
      if (restoreFocus) {
        const target = opener && opener.isConnected && !opener.disabled && !opener.closest('[inert]')
          ? opener : options.returnFocusFallback;
        focus(target);
      } else if (root.contains(doc.activeElement)) {
        doc.activeElement.blur();
      }
      opener = null;
    }

    return { show, hide, isOpen: () => active };
  }

  if (typeof module === 'object' && module.exports) module.exports = { create };
  else scope.RentalDialog = { create };
})(typeof window === 'undefined' ? globalThis : window);
