/** A very small DOM for rendering tests of modules that only build nodes with
 * createElement/createElementNS/append/textContent/attributes/classList and
 * look them up with simple `.class` or `tag` selectors. Not a browser: no
 * layout (offset/scroll sizes are 0), no event propagation beyond the target. */
class MiniClassList {
  constructor(node) { this.node = node; }
  get #set() { return new Set(this.node.className.split(/\s+/).filter(Boolean)); }
  contains(name) { return this.#set.has(name); }
  add(...names) { const set = this.#set; for (const name of names) set.add(name); this.node.className = [...set].join(' '); }
  remove(...names) { const set = this.#set; for (const name of names) set.delete(name); this.node.className = [...set].join(' '); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

class MiniNodeList {
  constructor(nodes) { nodes.forEach((node, index) => { this[index] = node; }); this.length = nodes.length; Object.freeze(this); }
  item(index) { return this[index] ?? null; }
  forEach(callback) { for (let index = 0; index < this.length; index += 1) callback(this[index], index, this); }
  *[Symbol.iterator]() { for (let index = 0; index < this.length; index += 1) yield this[index]; }
}

class MiniNode {
  constructor(doc, tag, text = null) {
    this.ownerDocument = doc;
    this.localName = tag;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty(key, value) { this[key] = value; } };
    this.className = '';
    this.classList = new MiniClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map();
    this.text = text;
    this.value = '';
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.offsetTop = 0; this.offsetHeight = 0;
  }
  get isText() { return this.localName === '#text'; }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new MiniNode(this.ownerDocument, '#text', node) : node;
      child.parentNode?.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      if (this.localName === 'select' && child.localName === 'option' && !this.value) this.value = child.value;
    }
  }
  removeChild(child) { this.children = this.children.filter((node) => node !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
  get textContent() { return this.isText ? this.text : this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); if (value != null && value !== '') this.append(String(value)); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'class') this.className = String(value); }
  getAttribute(key) { return key === 'class' ? this.className : (this.attributes.get(key) ?? null); }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
  dispatch(type, event = {}) { for (const handler of this.listeners.get(type) ?? []) handler({ target: this, preventDefault() {}, ...event }); }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false; }
  *walk() { for (const child of this.children) { if (!child.isText) { yield child; yield* child.walk(); } } }
  matches(selector) {
    return selector.split(',').map((part) => part.trim()).some((part) => {
      const [tag, ...classes] = part.split('.');
      return (!tag || tag === this.localName) && classes.every((name) => this.classList.contains(name));
    });
  }
  // Like a browser NodeList: indexable and iterable, but no array methods, so
  // code that calls .find/.map on it fails here as it would in a page.
  querySelectorAll(selector) { return new MiniNodeList([...this.walk()].filter((node) => node.matches(selector))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

export function createMiniDocument() {
  const doc = {
    activeElement: null,
    createElement: (tag) => new MiniNode(doc, tag),
    createElementNS: (_ns, tag) => new MiniNode(doc, tag),
    createTextNode: (text) => new MiniNode(doc, '#text', text),
  };
  doc.body = new MiniNode(doc, 'body');
  doc.activeElement = doc.body;
  return doc;
}

/** Every text node and accessible-name attribute under a node. */
export function exposedText(root) {
  const parts = [root.textContent];
  for (const node of root.walk()) for (const key of ['aria-label', 'title', 'alt']) if (node.getAttribute(key)) parts.push(node.getAttribute(key));
  return parts.join('\n');
}
