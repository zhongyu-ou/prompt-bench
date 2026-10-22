package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const openAIChatProtocol = "openai-chat-completions"

type ProtocolInfo struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	BaseURLHint        string   `json:"base_url_hint"`
	CredentialHint     string   `json:"credential_hint"`
	Roles              []string `json:"roles"`
	ReservedParameters []string `json:"reserved_parameters"`
	ParameterHints     []string `json:"parameter_hints"`
	Capabilities       []string `json:"capabilities"`
}
type PreparedRequest struct {
	Endpoint string
	Method   string
	Headers  map[string]string
	Body     json.RawMessage
}

func validateFrozenHeaders(headers map[string]string) error {
	for k := range headers {
		switch strings.ToLower(k) {
		case "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key":
			return errors.New("authentication headers cannot be frozen")
		}
	}
	return nil
}

// The adapter owns the wire contract; rendered messages and scheduling are protocol-neutral.
type Protocol interface {
	Info() ProtocolInfo
	Validate(Provider) error
	Prepare(Provider, string, []Message, map[string]any) (PreparedRequest, error)
	Authorize(*http.Request, string) error
	Decode([]byte) (responseModel string, output string, err error)
}

var protocolAdapters = []Protocol{openAIChat{}}

func lookupProtocol(id string) (Protocol, error) {
	for _, p := range protocolAdapters {
		if p.Info().ID == id {
			return p, nil
		}
	}
	return nil, fmt.Errorf("unsupported provider protocol %q", id)
}
func protocolCatalog() []ProtocolInfo {
	out := make([]ProtocolInfo, 0, len(protocolAdapters))
	for _, p := range protocolAdapters {
		out = append(out, p.Info())
	}
	out = append(out, ProtocolInfo{ID: typesafeProtocol, Name: "Typesafe SystemOne", BaseURLHint: "https://api.typesafe.ai/v1; /systemone is appended", CredentialHint: "Manual key overrides environment; authentication required", Roles: []string{}, ReservedParameters: []string{}, ParameterHints: []string{}, Capabilities: []string{"decision"}})
	return out
}
func validateProvider(p Provider) error {
	if p.APIKeyEnv != "" && !envName.MatchString(p.APIKeyEnv) {
		return errors.New("invalid api_key_env")
	}
	if p.Protocol == typesafeProtocol {
		_, err := typesafeEndpoint(p)
		return err
	}
	adapter, err := lookupProtocol(p.Protocol)
	if err != nil {
		return err
	}
	return adapter.Validate(p)
}
func validateParameters(parameters map[string]any, info ProtocolInfo) error {
	for key := range parameters {
		for _, reserved := range info.ReservedParameters {
			if strings.EqualFold(key, reserved) {
				return fmt.Errorf("parameter %q is reserved by %s; streaming is unsupported", key, info.Name)
			}
		}
	}
	return nil
}

type openAIChat struct{}

var openAIChatInfo = ProtocolInfo{ID: openAIChatProtocol, Name: "OpenAI Chat Completions", BaseURLHint: "Base URL ending in /v1; /chat/completions is appended", CredentialHint: "Manual key overrides environment; empty env plus no manual key explicitly permits anonymous requests", Roles: []string{"system", "developer", "user", "assistant"}, ReservedParameters: []string{"model", "messages", "stream"}, ParameterHints: []string{"temperature", "reasoning_effort"}, Capabilities: []string{"generation"}}

func (openAIChat) Info() ProtocolInfo { return openAIChatInfo }
func (openAIChat) endpoint(p Provider) (string, error) {
	u, err := url.Parse(p.BaseURL)
	if err != nil {
		return "", errors.New("invalid provider URL")
	}
	if (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("provider URL must be HTTP(S), without credentials, query or fragment")
	}
	return strings.TrimRight(u.String(), "/") + "/chat/completions", nil
}
func (a openAIChat) Validate(p Provider) error { _, err := a.endpoint(p); return err }
func (a openAIChat) Prepare(p Provider, model string, messages []Message, parameters map[string]any) (PreparedRequest, error) {
	endpoint, err := a.endpoint(p)
	if err != nil {
		return PreparedRequest{}, err
	}
	if err = validateParameters(parameters, a.Info()); err != nil {
		return PreparedRequest{}, err
	}
	info := a.Info()
	for _, m := range messages {
		valid := false
		for _, role := range info.Roles {
			if m.Role == role {
				valid = true
				break
			}
		}
		if !valid {
			return PreparedRequest{}, fmt.Errorf("unsupported message role %q for %s", m.Role, info.Name)
		}
	}
	body := make(map[string]any, len(parameters)+2)
	for k, v := range parameters {
		body[k] = v
	}
	body["model"] = model
	body["messages"] = messages
	raw, err := json.Marshal(body)
	return PreparedRequest{Endpoint: endpoint, Method: http.MethodPost, Headers: map[string]string{"Content-Type": "application/json"}, Body: raw}, err
}
func (openAIChat) Authorize(req *http.Request, key string) error {
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	return nil
}
func (openAIChat) Decode(raw []byte) (string, string, error) {
	var decoded struct {
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return decoded.Model, "", fmt.Errorf("decode response: %w", err)
	}
	if len(decoded.Choices) == 0 {
		return decoded.Model, "", errors.New("response has no choices")
	}
	content := decoded.Choices[0].Message.Content
	if len(content) == 0 {
		return decoded.Model, "", errors.New("response choice has no message content")
	}
	var output string
	if json.Unmarshal(content, &output) != nil {
		output = string(content)
	}
	return decoded.Model, output, nil
}
