package workbench

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"text/template"
	"text/template/parse"
)

// TemplateInputs describes discoverable top-level keys, not required fields or types.
type TemplateInputs struct {
	Keys    []string `json:"keys"`
	Dynamic bool     `json:"dynamic"`
}

type compiledPrompt struct {
	messages []*template.Template
	inputs   TemplateInputs
}

func compilePrompt(t Template) (*compiledPrompt, error) {
	compiled := &compiledPrompt{
		messages: make([]*template.Template, 0, len(t.Messages)),
		inputs:   TemplateInputs{Keys: []string{}},
	}
	keys := make(map[string]bool)
	for i, message := range t.Messages {
		if err := validMessage(message); err != nil {
			return nil, fmt.Errorf("template %s message %d: %w", t.Name, i+1, err)
		}
		tmpl, err := template.New("message").Parse(message.Content)
		if err != nil {
			return nil, fmt.Errorf("template %s message %d: %w", t.Name, i+1, err)
		}
		compiled.messages = append(compiled.messages, tmpl)
		walker := promptInputWalker{
			template: tmpl,
			keys:     keys,
			active:   make(map[promptVisit]bool),
			visited:  make(map[promptVisit]bool),
		}
		walker.walkTemplate(tmpl, promptSource{kind: promptRoot})
		compiled.inputs.Dynamic = compiled.inputs.Dynamic || walker.dynamic
	}
	for key := range keys {
		compiled.inputs.Keys = append(compiled.inputs.Keys, key)
	}
	sort.Strings(compiled.inputs.Keys)
	return compiled, nil
}

func templateInputs(t Template) (TemplateInputs, error) {
	compiled, err := compilePrompt(t)
	if err != nil {
		return TemplateInputs{}, err
	}
	return compiled.inputs, nil
}

// Sources track root identity rather than the shape or type of nested data.
// A literal is retained so index also understands a constant passed by a pipeline.
type promptSource struct {
	kind uint8
	name string
}

const (
	promptOther uint8 = iota // An element, constant, or nil; not the root object.
	promptRoot
	promptKey
	promptUnknown
	promptString
)

type promptBinding struct {
	name   string
	source promptSource
}

type promptScope struct {
	dot  promptSource
	vars []promptBinding
}

func (s promptScope) clone() promptScope {
	s.vars = append([]promptBinding(nil), s.vars...)
	return s
}

func (s *promptScope) variable(name string) promptSource {
	for i := len(s.vars) - 1; i >= 0; i-- {
		if s.vars[i].name == name {
			return s.vars[i].source
		}
	}
	return promptSource{kind: promptUnknown}
}

func (s *promptScope) assign(name string, source promptSource) {
	for i := len(s.vars) - 1; i >= 0; i-- {
		if s.vars[i].name == name {
			s.vars[i].source = source
			return
		}
	}
}

func mergePromptSource(a, b promptSource) promptSource {
	if a == b {
		return a
	}
	return promptSource{kind: promptUnknown}
}

// Only bindings present before the block survive it. Assignments update the
// nearest lexical binding; declarations in either branch cannot escape.
func mergePromptScope(dst *promptScope, a, b promptScope) bool {
	changed := false
	for i := range dst.vars {
		source := mergePromptSource(a.vars[i].source, b.vars[i].source)
		changed = changed || dst.vars[i].source != source
		dst.vars[i].source = source
	}
	return changed
}

type promptVisit struct {
	tree   *parse.Tree
	source promptSource
}

type promptLoop struct {
	exits []promptScope
}

type promptInputWalker struct {
	template *template.Template
	keys     map[string]bool
	dynamic  bool
	active   map[promptVisit]bool
	visited  map[promptVisit]bool
	loops    []*promptLoop
}

func (w *promptInputWalker) field(source promptSource, names []string) promptSource {
	if len(names) == 0 {
		return source
	}
	switch source.kind {
	case promptRoot:
		if names[0] != "TargetLanguageNameMap" {
			w.keys[names[0]] = true
		}
		return promptSource{kind: promptKey, name: names[0]}
	case promptUnknown:
		w.dynamic = true
	}
	return source
}

func (w *promptInputWalker) consume(source promptSource) {
	if source.kind == promptRoot || source.kind == promptUnknown {
		w.dynamic = true
	}
}

func (w *promptInputWalker) walkTemplate(tmpl *template.Template, source promptSource) {
	visit := promptVisit{tree: tmpl.Tree, source: source}
	if w.active[visit] {
		w.dynamic = true
		return
	}
	if w.visited[visit] {
		return
	}
	w.active[visit] = true
	scope := promptScope{dot: source, vars: []promptBinding{{name: "$", source: source}}}
	w.list(tmpl.Root, &scope)
	delete(w.active, visit)
	w.visited[visit] = true
}

func (w *promptInputWalker) list(list *parse.ListNode, scope *promptScope) {
	if list == nil {
		return
	}
	for _, node := range list.Nodes {
		switch n := node.(type) {
		case *parse.ActionNode:
			source := w.pipe(n.Pipe, scope)
			if len(n.Pipe.Decl) == 0 {
				w.consume(source)
			}
		case *parse.IfNode:
			w.branch(&n.BranchNode, scope, false)
		case *parse.WithNode:
			w.branch(&n.BranchNode, scope, true)
		case *parse.RangeNode:
			w.rangeList(n, scope)
		case *parse.TemplateNode:
			source := w.pipe(n.Pipe, scope)
			called := w.template.Lookup(n.Name)
			if called == nil {
				w.dynamic = true
				continue
			}
			w.walkTemplate(called, source)
		case *parse.BreakNode, *parse.ContinueNode:
			if len(w.loops) > 0 {
				loop := w.loops[len(w.loops)-1]
				loop.exits = append(loop.exits, scope.clone())
			}
		}
	}
}

func (w *promptInputWalker) branch(node *parse.BranchNode, scope *promptScope, with bool) {
	body := scope.clone()
	source := w.pipe(node.Pipe, &body)
	otherwise := body.clone()
	if with {
		body.dot = source
	}
	w.list(node.List, &body)
	w.list(node.ElseList, &otherwise)
	mergePromptScope(scope, body, otherwise)
}

func (w *promptInputWalker) rangeList(node *parse.RangeNode, scope *promptScope) {
	header := scope.clone()
	w.consume(w.pipe(node.Pipe, &header))
	loop := &promptLoop{}
	w.loops = append(w.loops, loop)
	defer func() { w.loops = w.loops[:len(w.loops)-1] }()
	zero := header.clone()
	w.list(node.ElseList, &zero)
	zero.vars = zero.vars[:len(header.vars)]
	for _, exit := range loop.exits {
		mergePromptScope(&zero, zero, exit)
	}
	entry := header.clone()
	for {
		body := entry.clone()
		loop.exits = nil
		body.dot = promptSource{kind: promptOther}
		for _, variable := range node.Pipe.Decl {
			body.assign(variable.Ident[0], promptSource{kind: promptOther})
		}
		w.list(node.List, &body)
		body.vars = body.vars[:len(header.vars)]
		// Early loop exits may bypass later assignments. Keep those sources
		// as alternatives instead of allowing a later statement to hide them.
		for _, exit := range loop.exits {
			mergePromptScope(&body, body, exit)
		}
		// Joining the initial state with a possible iteration reaches a finite
		// fixed point, including aliases changed only on later iterations.
		next := header.clone()
		mergePromptScope(&next, header, body)
		if !mergePromptScope(&entry, entry, next) {
			mergePromptScope(scope, zero, body)
			return
		}
	}
}

func (w *promptInputWalker) pipe(pipe *parse.PipeNode, scope *promptScope) promptSource {
	if pipe == nil {
		return promptSource{kind: promptOther}
	}
	var source promptSource
	for i, command := range pipe.Cmds {
		source = w.command(command, scope, source, i > 0)
	}
	for _, variable := range pipe.Decl {
		if pipe.IsAssign {
			scope.assign(variable.Ident[0], source)
		} else {
			scope.vars = append(scope.vars, promptBinding{name: variable.Ident[0], source: source})
		}
	}
	return source
}

func (w *promptInputWalker) command(command *parse.CommandNode, scope *promptScope, piped promptSource, hasPiped bool) promptSource {
	if len(command.Args) == 1 && !hasPiped {
		if _, function := command.Args[0].(*parse.IdentifierNode); !function {
			return w.value(command.Args[0], scope)
		}
	}
	args := make([]promptSource, 0, len(command.Args))
	for _, arg := range command.Args[1:] {
		args = append(args, w.value(arg, scope))
	}
	if hasPiped {
		args = append(args, piped)
	}
	if function, ok := command.Args[0].(*parse.IdentifierNode); ok {
		switch function.Ident {
		case "index":
			if len(args) < 2 {
				return promptSource{kind: promptUnknown}
			}
			source := args[0]
			for _, key := range args[1:] {
				w.consume(key)
				if source.kind == promptRoot {
					if key.kind == promptString {
						source = w.field(source, []string{key.name})
					} else {
						w.dynamic = true
						source = promptSource{kind: promptUnknown}
					}
				} else if source.kind == promptUnknown {
					w.dynamic = true
				}
			}
			return source
		case "and", "or":
			if len(args) == 0 {
				return promptSource{kind: promptOther}
			}
			source := args[0]
			for _, arg := range args[1:] {
				source = mergePromptSource(source, arg)
			}
			return source
		case "call":
			w.dynamic = true
		}
	} else {
		w.consume(w.value(command.Args[0], scope))
		for _, arg := range args {
			w.consume(arg)
		}
		return promptSource{kind: promptUnknown}
	}
	for _, arg := range args {
		w.consume(arg)
	}
	return promptSource{kind: promptOther}
}

func (w *promptInputWalker) value(node parse.Node, scope *promptScope) promptSource {
	switch n := node.(type) {
	case *parse.DotNode:
		return scope.dot
	case *parse.FieldNode:
		return w.field(scope.dot, n.Ident)
	case *parse.VariableNode:
		return w.field(scope.variable(n.Ident[0]), n.Ident[1:])
	case *parse.ChainNode:
		return w.field(w.value(n.Node, scope), n.Field)
	case *parse.PipeNode:
		return w.pipe(n, scope)
	case *parse.StringNode:
		return promptSource{kind: promptString, name: n.Text}
	}
	return promptSource{kind: promptOther}
}

func (a *API) templateInputsAPI(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/templates/inputs" {
		return false
	}
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
		return true
	}
	var in struct {
		StateVersion int64  `json:"state_version"`
		TemplateID   string `json:"template_id"`
	}
	if err := decode(w, r, &in); err != nil {
		fail(w, http.StatusBadRequest, err)
		return true
	}
	state, err := a.store.state()
	if err != nil {
		fail(w, http.StatusInternalServerError, fmt.Errorf("could not read state"))
		return true
	}
	if state.Version != in.StateVersion {
		fail(w, http.StatusConflict, errStale)
		return true
	}
	if in.TemplateID == "" {
		fail(w, http.StatusBadRequest, fmt.Errorf("template_id required"))
		return true
	}
	for _, t := range state.Templates {
		if t.ID != in.TemplateID {
			continue
		}
		inputs, err := templateInputs(t)
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return true
		}
		example := make(map[string]string, len(inputs.Keys))
		for _, key := range inputs.Keys {
			example[key] = ""
		}
		raw, err := json.MarshalIndent(example, "", "  ")
		if err != nil {
			fail(w, http.StatusInternalServerError, err)
			return true
		}
		sendJSON(w, http.StatusOK, struct {
			StateVersion int64  `json:"state_version"`
			TemplateID   string `json:"template_id"`
			TemplateInputs
			ExampleJSON string `json:"example_json"`
		}{state.Version, t.ID, inputs, string(raw)})
		return true
	}
	fail(w, http.StatusNotFound, fmt.Errorf("template %s not found", in.TemplateID))
	return true
}
