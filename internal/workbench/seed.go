package workbench

import _ "embed"

// Copied from the supplied experiment template; no runtime dependency on Agent Evals.
//
//go:embed seed.tmpl
var seedTemplate string

func seedState() (State, error) {
	cases := []Case{
		{ID: newID(), Variables: map[string]any{"PriorText": "广大劳动群众紧紧团结在党的周围。\n奋力拼搏进取，勇于创新。\n创造，为党和国家事业发展作出了重要贡献。\n总书记的节日祝贺和诚挚慰问。\n激励着每一位奋斗者。", "CurrentText": "习近平总书记勉励广大劳动群众大力弘扬劳模精神。"}},
		{ID: newID(), Variables: map[string]any{"PriorText": "问渠哪得清如许？为有源头活水来。\n如果刑罚权不加限制，那么历史上“欲加之罪，何患无辞”的惨剧就会一而再、再而三地上演。\n直到我体会了法律刑罚的悖论性。\n我才真正意识到法律的精神和法治的真谛。\n我是一个长期生活在书斋里的法律人。", "CurrentText": "法治的理念要得到践行。"}},
		{ID: newID(), Variables: map[string]any{"PriorText": "提高智能化运营水平，积极发展多式联运。\n扩大辐射带动效应。\n在北海市，李强来到金海湾红树林生态保护区。\n细致询问红树林保护情况。\n他指出，水生态保护是水网建设重要内容。", "CurrentText": "要坚持系统治理综合治理源头治理。"}},
		{ID: newID(), Variables: map[string]any{"PriorText": "没有捷径，唯有实干。\n在繁忙的生产车间，在火热的春耕现场。\n在国家重点实验室，广大劳动者牢记总书记嘱托。\n以时不我待、只争朝夕的精神，\n奋进“十五五”，用辛勤劳动不断书写中国式现代化新篇章。", "CurrentText": "习近平总书记向广大劳动群众致以节日祝贺和诚挚慰问。"}},
	}
	ids := []string{}
	for i := range cases {
		cases[i].Variables["SourceLanguage"] = "zh-CN"
		cases[i].Variables["ReplacementMap"] = ""
		ids = append(ids, cases[i].ID)
	}
	s := State{Version: 1, Cases: cases, Collections: []Collection{}, Templates: []Template{{ID: "asr", Name: "ASR proofreader · Go template", Messages: []Message{{Role: "user", Content: seedTemplate}}}}, Providers: []Provider{{ID: "luna", Name: "Luna", BaseURL: "https://polyglot-jpe-prod.openai.azure.com/openai/v1", APIKeyEnv: "AZURE_OPENAI_API_KEY"}, {ID: "4o", Name: "GPT-4o", BaseURL: "https://dev-openai-rtc.openai.azure.com/openai/v1", APIKeyEnv: "AZURE_OPENAI_4O_KEY"}}, Settings: Settings{DefaultRuns: 20, Concurrency: 20, TimeoutSeconds: 120}, Draft: Draft{Name: "ASR comparison", CaseIDs: ids, Groups: []Group{{ID: "luna", Name: "Luna · none", Enabled: true, TemplateID: "asr", ProviderID: "luna", Model: "gpt-6-luna", Parameters: map[string]any{"reasoning_effort": "none"}, Runs: 20}, {ID: "4o", Name: "GPT-4o", Enabled: true, TemplateID: "asr", ProviderID: "4o", Model: "gpt-4o", Parameters: map[string]any{}, Runs: 20}}}}
	for i := range s.Draft.Groups {
		s.Draft.Groups[i].LanguageRoutes = []LanguageRoute{{SourceLanguage: "zh-CN", Targets: []Target{{Key: "en", Name: "English"}}}}
	}
	for i := range s.Providers {
		s.Providers[i].Protocol = openAIChatProtocol
		s.Providers[i].CredentialRef = "cred_" + newID()
	}
	return s, validateState(s)
}
