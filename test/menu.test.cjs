const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function start(initial = {}) {
    const storage = { ...initial };
    const settings = {};
    const handlers = {};
    let active;
    let selected;
    let component;
    const lampa = {
        SettingsApi: {
            addComponent(data) { component = data; },
            addParam(data) { settings[data.param.name] = data; }
        },
        Storage: {
            field(name) {
                return Object.hasOwn(storage, name) ? storage[name] : settings[name]?.param.default;
            },
            set(name, value) {
                storage[name] = value;
                handlers.change?.({ name, value });
            },
            listener: { follow(name, callback) { handlers[name] = callback; } }
        },
        Player: { listener: { follow() {} } },
        Select: {
            listener: { follow(name, callback) { handlers[name] = callback; } },
            show(menu) {
                active = menu;
                handlers.preshow?.({ active: menu });
            }
        }
    };
    const document = { addEventListener() {}, querySelector() { return null; } };
    const window = { appready: true, Lampa: lampa };
    const code = fs.readFileSync(path.join(__dirname, '..', 'lampa-anime4k.js'), 'utf8');
    vm.runInNewContext(code, {
        window, document, Element: class {}, HTMLVideoElement: class {}, queueMicrotask
    });
    const parent = {
        items: [{ method: 'size' }, { method: 'speed' }],
        onSelect(item) { selected = item.method; }
    };
    return {
        status: () => window.LampaAnime4K.status(),
        component: () => component,
        storage,
        open: () => lampa.Select.show(parent),
        active: () => active,
        parent,
        selected: () => selected
    };
}

const app = start({ lampa_anime4k_enabled: true });
assert.match(app.component().icon, /<svg\b/);
assert.match(app.component().icon, /viewBox="0 0 40 40"/);
assert.equal(app.status().profile, 'restore');
app.open();
assert.equal(app.active().items.filter(item => item.anime4kMenu).length, 1);
app.active().onSelect(app.active().items[0]);
assert.equal(app.selected(), 'size');
app.active().items.find(item => item.anime4kMenu).onSelect();
assert.equal(app.active().items.find(item => item.value === 'restore').selected, true);
app.active().onSelect(app.active().items.find(item => item.value === 'fast'));
assert.equal(app.status().profile, 'fast');
assert.equal(app.status().enabled, true);
assert.equal(app.active().items.find(item => item.anime4kMenu).subtitle, 'Быстрый');
app.active().items.find(item => item.anime4kMenu).onSelect();
app.active().onSelect(app.active().items.find(item => item.value === 'off'));
assert.equal(app.status().enabled, false);
assert.equal(app.storage.lampa_anime4k_profile, 'fast');
app.active().items.find(item => item.anime4kMenu).onSelect();
app.active().onBack();
assert.equal(app.active().items.filter(item => item.anime4kMenu).length, 1);

const restored = start(app.storage);
assert.equal(restored.status().enabled, false);
assert.equal(restored.status().profile, 'fast');
console.log('Player menu and saved profiles passed');
