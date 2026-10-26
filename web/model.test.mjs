import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from './js/state.js';
import { caseEditorDirty, ensureSelections, selectedCaseIds } from './js/model.js';
import { buildCaseVariablePatch, rebaseCaseEditor } from './js/case-editor.js';
import { caseTextOf, stableStringify } from './js/utils.js';
import { libraryFilteredCases } from './js/case-library.js';

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

test('the first run Case follows explicit selection then deduplicated collections, never the library or active Case', () => {
  const previous = { ...App };
  try {
    Object.assign(App, {
      state: {
        cases: ['a', 'b', 'c', 'd'].map((id) => ({ id, variables: {} })),
        collections: [
          { id: 'first', case_ids: ['c', 'b', 'd', 'missing'] },
          { id: 'second', case_ids: ['a', 'd'] }
        ],
        draft: {
          case_ids: ['b', 'a', 'b', 'missing'],
          collection_ids: ['first', 'second'],
          excluded_case_ids: ['a']
        }
      },
      activeCaseId: 'a',
      library: { selected: new Set(['a']) }
    });
    assert.deepEqual(selectedCaseIds(), ['b', 'c', 'd']);
    App.state.draft.case_ids = [];
    assert.deepEqual(selectedCaseIds(), ['c', 'b', 'd']);
    App.state.draft.collection_ids = [];
    assert.deepEqual(selectedCaseIds(), []);
  } finally {
    Object.assign(App, previous);
  }
});

test('Case excerpts prefer CurrentText then the first sorted nonempty string, excluding source language', () => {
  assert.equal(caseTextOf({ variables: { text: 'new service', CurrentText: 'current', SourceLanguage: 'zh' } }), 'current');
  assert.equal(caseTextOf({ variables: { z: 'last', context: 'first', CurrentText: '', SourceLanguage: 'zh' } }), 'first');
  assert.equal(caseTextOf({ variables: { text: 'fallback', CurrentText: ' \n ', SourceLanguage: 'zh' } }), 'fallback');
  assert.equal(caseTextOf({ variables: { number: 1, obj: { text: 'nested' }, nil: null, SourceLanguage: 'zh' } }), '');
  assert.equal(caseTextOf({ variables: JSON.parse('{"__proto__":"literal key","SourceLanguage":"zh"}') }), 'literal key');
  assert.equal(caseTextOf(null), '');
});

function caseEditorFixture(raw = '{}') {
  const variables = JSON.parse(raw);
  return {
    mode: 'edit', sourceId: 'case',
    baseline: { raw, variables, parsedOk: true },
    variables,
    fieldValues: new Map(Object.entries(variables)),
    editedFields: new Set(), removedFields: new Set(),
    baselineCollections: new Set(), collectionIds: new Set(),
    tab: 'form', jsonText: raw, jsonValid: true, jsonError: ''
  };
}

function submittedEditor(ed) {
  return {
    tab: ed.tab, jsonText: ed.jsonText,
    fieldValues: new Map(ed.fieldValues),
    editedFields: new Set(ed.editedFields),
    removedFields: new Set(ed.removedFields),
    collectionIds: new Set(ed.collectionIds)
  };
}

test('generic string patches preserve untouched missing keys and raw unknown number lexemes', () => {
  const raw = '{"text":"old","large":9007199254740993,"decimal":1.00,"obj":{"n":1.2300e+2},"nil":null,"array":[]}';
  const ed = caseEditorFixture(raw);
  assert.deepEqual(buildCaseVariablePatch(ed), { patch: {}, remove: [] });
  ed.fieldValues.set('text', 'new');
  ed.editedFields.add('text');
  ed.fieldValues.set('explicit-empty', '');
  ed.editedFields.add('explicit-empty');
  ed.fieldValues.set('__proto__', '<script>literal</script>');
  ed.editedFields.add('__proto__');
  ed.fieldValues.delete('nil');
  ed.removedFields.add('nil');
  const { patch, remove } = buildCaseVariablePatch(ed);
  assert.deepEqual(Object.keys(patch), ['text', 'explicit-empty', '__proto__']);
  assert.equal(patch['explicit-empty'], '');
  assert.equal(patch.__proto__, '<script>literal</script>');
  assert.equal(Object.getPrototypeOf(patch), Object.prototype);
  assert.equal(Object.hasOwn(patch, 'missing'), false);
  assert.deepEqual(remove, ['nil']);
  assert.equal(ed.jsonText, raw); // This exact string, not ed.variables, is sent to the merge API.
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), patch);
});

test('generic Case editor dirty guard covers missing versus added empty, removals, JSON and memberships', () => {
  const previous = App.caseEditor;
  try {
    const ed = caseEditorFixture('{"text":"original"}');
    App.caseEditor = ed;
    assert.equal(caseEditorDirty(), false);
    ed.fieldValues.set('empty', '');
    ed.editedFields.add('empty');
    assert.equal(caseEditorDirty(), true);
    ed.fieldValues.delete('empty');
    ed.editedFields.clear();
    assert.equal(caseEditorDirty(), false);
    ed.removedFields.add('text');
    assert.equal(caseEditorDirty(), true);
    ed.removedFields.clear();
    ed.jsonText = '{"text":"edited"}';
    assert.equal(caseEditorDirty(), true);
    ed.jsonText = ed.baseline.raw;
    ed.collectionIds.add('collection');
    assert.equal(caseEditorDirty(), true);
  } finally {
    App.caseEditor = previous;
  }
});

test('save rebasing retains only field and membership changes made after the submitted snapshot', () => {
  const raw = '{"text":"old","remove":"old","large":9007199254740993,"decimal":1.00}';
  const ed = caseEditorFixture(raw);
  ed.fieldValues.set('text', 'submitted');
  ed.editedFields.add('text');
  ed.fieldValues.set('saved-empty', '');
  ed.editedFields.add('saved-empty');
  const submitted = submittedEditor(ed);
  ed.fieldValues.set('text', 'typed while saving');
  ed.fieldValues.set('__proto__', '');
  ed.editedFields.add('__proto__');
  ed.fieldValues.delete('remove');
  ed.removedFields.add('remove');
  ed.collectionIds.add('later-membership');
  const savedRaw = '{"text":"submitted","remove":"old","saved-empty":"","large":9007199254740993,"decimal":1.00}';
  rebaseCaseEditor(ed, submitted, { id: 'created', variables_json: savedRaw }, []);
  assert.equal(ed.mode, 'edit');
  assert.equal(ed.sourceId, 'created');
  assert.equal(ed.baseline.raw, savedRaw);
  assert.equal(ed.jsonText, savedRaw);
  assert.equal(ed.fieldValues.get('text'), 'typed while saving');
  assert.equal(ed.fieldValues.get('saved-empty'), '');
  assert.deepEqual(buildCaseVariablePatch(ed), {
    patch: Object.fromEntries([['text', 'typed while saving'], ['__proto__', '']]),
    remove: ['remove']
  });
  assert.deepEqual([...ed.collectionIds], ['later-membership']);
  assert.deepEqual([...ed.baselineCollections], []);
});

test('rebasing a submitted removal retains a same-key string added during save', () => {
  const ed = caseEditorFixture('{"text":"old","custom-key":"old"}');
  ed.fieldValues.delete('custom-key');
  ed.removedFields.add('custom-key');
  const submitted = submittedEditor(ed);
  ed.fieldValues.set('custom-key', '');
  ed.editedFields.add('custom-key');
  ed.removedFields.delete('custom-key');
  rebaseCaseEditor(ed, submitted, { id: 'case', variables_json: '{"text":"old"}' }, []);
  assert.deepEqual(buildCaseVariablePatch(ed), { patch: { 'custom-key': '' }, remove: [] });
});

test('rebasing advanced JSON preserves pending valid or invalid input verbatim', () => {
  for (const currentJson of ['{"text":"later","large":9007199254740993}', '{"text":']) {
    const ed = caseEditorFixture('{"text":"old","large":9007199254740993}');
    ed.tab = 'json';
    ed.jsonText = '{"text":"submitted","large":9007199254740993}';
    const submitted = submittedEditor(ed);
    ed.jsonText = currentJson;
    rebaseCaseEditor(ed, submitted, { id: 'case', variables_json: submitted.jsonText }, []);
    assert.equal(ed.jsonText, currentJson);
    assert.equal(ed.baseline.raw, submitted.jsonText);
    assert.equal(ed.jsonValid, currentJson.endsWith('}'));
    assert.deepEqual(buildCaseVariablePatch(ed), { patch: {}, remove: [] });
  }
});

test('rebasing an unchanged submitted editor produces a clean generic editor', () => {
  const previous = App.caseEditor;
  try {
    const ed = caseEditorFixture('{"text":"old","large":9007199254740993}');
    ed.fieldValues.set('text', 'saved');
    ed.editedFields.add('text');
    const submitted = submittedEditor(ed);
    rebaseCaseEditor(ed, submitted, { id: 'case', variables_json: '{"text":"saved","large":9007199254740993}' }, []);
    App.caseEditor = ed;
    assert.equal(caseEditorDirty(), false);
    assert.deepEqual(buildCaseVariablePatch(ed), { patch: {}, remove: [] });
  } finally {
    App.caseEditor = previous;
  }
});

test('Case search matches every top-level string, not only the displayed excerpt', () => {
  const previous = { ...App };
  try {
    Object.assign(App, {
      state: {
        cases: [
          { id: 'first', variables: { CurrentText: 'displayed', context: 'hidden Needle', SourceLanguage: 'zh' } },
          { id: 'second', variables: { text: 'other', nested: { text: 'needle' }, number: 123 } },
          { id: 'third', variables: JSON.parse('{"__proto__":"literal needle"}') }
        ],
        collections: []
      },
      library: { search: 'NEEDLE', source: '', collectionId: null }
    });
    assert.deepEqual(libraryFilteredCases().map((c) => c.id), ['first', 'third']);
    App.library.search = 'SECOND';
    assert.deepEqual(libraryFilteredCases().map((c) => c.id), ['second']);
    App.library.search = 'zh';
    assert.deepEqual(libraryFilteredCases().map((c) => c.id), ['first']);
    App.library.search = '123';
    assert.deepEqual(libraryFilteredCases(), []);
  } finally {
    Object.assign(App, previous);
  }
});

test('saved-state serialization preserves own prototype-shaped Case field keys', () => {
  const value = JSON.parse('{"cases":[{"variables":{"__proto__":{"text":"own key"},"constructor":"literal"}}]}');
  const decoded = JSON.parse(stableStringify(value));
  assert.equal(Object.hasOwn(decoded.cases[0].variables, '__proto__'), true);
  assert.deepEqual(decoded, value);
  assert.equal({}.text, undefined);
});
