(() => {
  const COMMAND_ATTRIBUTE = 'data-aibrowser-rpa-command';
  const RESULT_ATTRIBUTE = 'data-aibrowser-rpa-result';

  function findElement(selector, selectorRadio) {
    const query = String(selector || '').trim();
    if (!query) return null;
    const mode = String(selectorRadio || 'CSS').toUpperCase();
    if (mode === 'XPATH' || mode === 'XP' || mode.startsWith('XPATH')) {
      return document.evaluate(query, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }
    return document.querySelector(query);
  }

  function writeValue(element, content, clear) {
    const text = String(content ?? '');
    if (element.isContentEditable) {
      const previous = String(element.textContent || '');
      element.textContent = clear ? text : previous + text;
    } else if ('value' in element) {
      const previous = String(element.value || '');
      let next = text;
      if (!clear) {
        const start = Number.isInteger(element.selectionStart) ? element.selectionStart : previous.length;
        const end = Number.isInteger(element.selectionEnd) ? element.selectionEnd : start;
        next = previous.slice(0, start) + text + previous.slice(end);
      }
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, next);
      else element.value = next;
    } else {
      throw new Error('Element does not accept text input');
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function reply(id, success, error = null) {
    document.documentElement.setAttribute(RESULT_ATTRIBUTE, JSON.stringify({ id, success, error }));
  }

  function visibleOptions(root = document) {
    return [...root.querySelectorAll('[role="option"]')].filter((option) => {
      const style = getComputedStyle(option);
      const rect = option.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
  }

  async function selectOption(element, command) {
    const requestedIndex = Number(command.optionIndex);
    const requestedValue = String(command.optionValue ?? '').trim();
    const requestedText = String(command.optionText ?? '').trim();
    const currentValue = String(element.getAttribute('value') ?? element.value ?? '').trim();
    if (requestedValue && currentValue === requestedValue) return true;

    element.focus?.();
    element.click?.();
    const deadline = Date.now() + Math.max(800, Number(command.timeout) || 4000);
    while (Date.now() < deadline) {
      const controlledId = element.getAttribute('aria-controls');
      const controlled = controlledId ? document.getElementById(controlledId) : null;
      const options = visibleOptions(controlled || document);
      let option = null;
      if (Number.isInteger(requestedIndex) && requestedIndex > 0) option = options[requestedIndex - 1] || null;
      if (!option && requestedValue) {
        option = options.find((item) => String(item.getAttribute('value') ?? item.dataset?.value ?? '').trim() === requestedValue) || null;
      }
      if (!option && requestedText) {
        option = options.find((item) => String(item.textContent || '').trim() === requestedText) || null;
      }
      if (option) {
        option.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        option.click?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('Dropdown option not found: ' + (requestedText || requestedValue || requestedIndex));
  }

  async function executeCommand(raw) {
    let command;
    try {
      command = JSON.parse(String(raw || ''));
      if (!command?.id || !['focus', 'input', 'click', 'selectOption'].includes(command.action)) return;
      const element = findElement(command.selector, command.selectorRadio);
      if (!element) throw new Error('Selector not found: ' + command.selector);
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      if (command.action === 'focus') {
        element.focus?.();
        reply(command.id, document.activeElement === element);
        return;
      }
      if (command.action === 'input') {
        element.focus?.();
        writeValue(element, command.content, Boolean(command.clear));
        reply(command.id, true);
        return;
      }
      if (command.action === 'selectOption') {
        await selectOption(element, command);
        reply(command.id, true);
        return;
      }
      // Reply before click: form submissions may destroy this document immediately.
      reply(command.id, true);
      setTimeout(() => element.click(), 0);
    } catch (error) {
      if (command?.id) reply(command.id, false, String(error?.message || error));
    } finally {
      document.documentElement.removeAttribute(COMMAND_ATTRIBUTE);
    }
  }

  const observer = new MutationObserver((records) => {
    if (!records.some((record) => record.attributeName === COMMAND_ATTRIBUTE)) return;
    const raw = document.documentElement.getAttribute(COMMAND_ATTRIBUTE);
    if (raw) executeCommand(raw);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [COMMAND_ATTRIBUTE] });

  // Environment labels belong to the live-sync lifecycle. Ordinary browsing
  // must not inject a permanent page badge (the former blue "OB" marker).
  document.getElementById('aibrowser-profile-marker')?.remove();
})();
