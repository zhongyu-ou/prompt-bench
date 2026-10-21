import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from './js/state.js';
import { ensureSelections } from './js/model.js';

test('saving state preserves the edited template instead of switching to the active group binding', () => {
  const previous = { ...App };
  try {
    Object.assign(App, {
      state: {
        cases: [], collections: [],
        templates: [
          { id: 'bound', messages: [{ role: 'user', content: 'bound message' }] },
          { id: 'editing', messages: [{ role: 'system', content: 'first' }, { role: 'user', content: 'second' }] }
        ],
        draft: { groups: [{ id: 'group', template_id: 'bound' }] }
      },
      activeGroupId: 'group', activeTemplateId: 'editing', activeMessageIndex: 1,
      library: { collectionId: null, selected: new Set() }
    });
    App.state = structuredClone(App.state); // A successful save adopts fresh server objects.
    ensureSelections();
    assert.equal(App.activeTemplateId, 'editing');
    assert.equal(App.activeMessageIndex, 1);
    assert.equal(App.state.draft.groups[0].template_id, 'bound');

    App.state.templates = App.state.templates.filter((t) => t.id !== 'editing');
    ensureSelections();
    assert.equal(App.activeTemplateId, 'bound');
    assert.equal(App.activeMessageIndex, 0);
  } finally {
    Object.assign(App, previous);
  }
});
