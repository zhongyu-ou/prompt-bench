package workbench

import "encoding/json"

type Case struct {
	ID        string         `json:"id"`
	Variables map[string]any `json:"variables"`
}

// SnapshotCase keeps legacy metadata in immutable historical snapshots only.
type SnapshotCase struct {
	ID          string         `json:"id"`
	Name        string         `json:"name,omitempty"`
	Description string         `json:"description,omitempty"`
	Variables   map[string]any `json:"variables"`
}
type Collection struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	CaseIDs []string `json:"case_ids"`
}
type Target struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}
type LanguageRoute struct {
	SourceLanguage string   `json:"source_language"`
	Targets        []Target `json:"targets"`
}
type LanguageResolution struct {
	SourceLanguage string   `json:"source_language"`
	Targets        []Target `json:"targets"`
	UsedDefault    bool     `json:"used_default"`
}
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type Template struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Messages []Message `json:"messages"`
}
type Provider struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	BaseURL       string `json:"base_url"`
	APIKeyEnv     string `json:"api_key_env"`
	Protocol      string `json:"protocol"`
	CredentialRef string `json:"credential_ref"`
}
type Group struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Enabled        bool            `json:"enabled"`
	TemplateID     string          `json:"template_id"`
	ProviderID     string          `json:"provider_id"`
	Model          string          `json:"model"`
	Parameters     map[string]any  `json:"parameters"`
	Runs           int             `json:"runs"`
	LanguageRoutes []LanguageRoute `json:"language_routes"`
}
type Settings struct {
	DefaultRuns    int `json:"default_runs"`
	Concurrency    int `json:"concurrency"`
	TimeoutSeconds int `json:"timeout_seconds"`
}
type Draft struct {
	Name            string   `json:"name"`
	CaseIDs         []string `json:"case_ids"`
	CollectionIDs   []string `json:"collection_ids"`
	ExcludedCaseIDs []string `json:"excluded_case_ids"`
	Groups          []Group  `json:"groups"`
}
type State struct {
	Version     int64        `json:"version"`
	Cases       []Case       `json:"cases"`
	Collections []Collection `json:"collections"`
	Templates   []Template   `json:"templates"`
	Providers   []Provider   `json:"providers"`
	Settings    Settings     `json:"settings"`
	Draft       Draft        `json:"draft"`
}
type RunInput struct {
	StateVersion    int64    `json:"state_version"`
	Name            string   `json:"name"`
	CaseIDs         []string `json:"case_ids"`
	CollectionIDs   []string `json:"collection_ids"`
	ExcludedCaseIDs []string `json:"excluded_case_ids"`
	Groups          []Group  `json:"groups"`
	Concurrency     int      `json:"concurrency"`
}
type FrozenRequest struct {
	CaseID             string              `json:"case_id"`
	CaseName           string              `json:"case_name,omitempty"`
	GroupID            string              `json:"group_id"`
	GroupName          string              `json:"group_name"`
	Model              string              `json:"model"`
	Endpoint           string              `json:"endpoint"`
	Method             string              `json:"method"`
	Headers            map[string]string   `json:"headers"`
	APIKeyEnv          string              `json:"api_key_env"`
	Protocol           string              `json:"protocol"`
	CredentialRef      string              `json:"credential_ref"`
	RequiresAuth       bool                `json:"requires_auth"`
	Request            json.RawMessage     `json:"request"`
	RawRequest         string              `json:"raw_request"`
	PromptHash         string              `json:"prompt_hash"`
	Runs               int                 `json:"runs"`
	LanguageResolution *LanguageResolution `json:"language_resolution,omitempty"`
}
type Snapshot struct {
	Cases          []SnapshotCase  `json:"cases"`
	Templates      []Template      `json:"templates"`
	Providers      []Provider      `json:"providers"`
	Groups         []Group         `json:"groups"`
	CaseIDs        []string        `json:"case_ids"`
	TimeoutSeconds int             `json:"timeout_seconds"`
	Requests       []FrozenRequest `json:"requests"`
	Selection      *Selection      `json:"selection,omitempty"`
	Collections    []Collection    `json:"collections,omitempty"`
}
type Selection struct {
	CaseIDs         []string `json:"case_ids"`
	CollectionIDs   []string `json:"collection_ids"`
	ExcludedCaseIDs []string `json:"excluded_case_ids"`
}
type Batch struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
	FinishedAt  string `json:"finished_at"`
	Total       int    `json:"total"`
	Completed   int    `json:"completed"`
	Failed      int    `json:"failed"`
	Cancelled   int    `json:"cancelled"`
	Interrupted int    `json:"interrupted"`
	InFlight    int    `json:"in_flight"`
	Concurrency int    `json:"concurrency"`
	ReplayOf    string `json:"replay_of"`
}
type Result struct {
	ID                string          `json:"id"`
	CaseID            string          `json:"case_id"`
	CaseName          string          `json:"case_name"`
	GroupID           string          `json:"group_id"`
	GroupName         string          `json:"group_name"`
	Iteration         int             `json:"iteration"`
	Status            string          `json:"status"`
	Model             string          `json:"model"`
	ResponseModel     string          `json:"response_model"`
	Request           json.RawMessage `json:"request"`
	RawRequest        string          `json:"raw_request"`
	RawResponse       string          `json:"raw_response"`
	RawResponseBase64 string          `json:"raw_response_base64,omitempty"`
	Output            string          `json:"output"`
	Error             string          `json:"error"`
	HTTPStatus        int             `json:"http_status"`
	DurationMS        int64           `json:"duration_ms"`
	StartedAt         string          `json:"started_at"`
	FinishedAt        string          `json:"finished_at"`
	PromptHash        string          `json:"prompt_hash"`
}
type Detail struct {
	Batch    Batch    `json:"batch"`
	Snapshot Snapshot `json:"snapshot"`
	Results  []Result `json:"results"`
}

type CredentialUpdate struct {
	Action string `json:"action"`
	Key    string `json:"key,omitempty"`
}
type CredentialStatus struct {
	ManualSet    bool   `json:"manual_set"`
	EnvAvailable bool   `json:"env_available"`
	Source       string `json:"source"`
	Available    bool   `json:"available"`
	RequiresAuth bool   `json:"requires_auth"`
}
type StateWrite struct {
	State
	CredentialUpdates map[string]CredentialUpdate `json:"credential_updates,omitempty"`
	Credentials       map[string]CredentialStatus `json:"credentials,omitempty"`
}
type StateView struct {
	State
	Credentials map[string]CredentialStatus `json:"credentials"`
}
