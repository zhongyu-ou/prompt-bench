package workbench

import "testing"

func TestSeedIncludesTypesafeDecisionProvider(t *testing.T) {
	st, err := seedState()
	if err != nil {
		t.Fatal(err)
	}
	var found *Provider
	for i := range st.Providers {
		if st.Providers[i].Protocol == typesafeProtocol {
			if found != nil {
				t.Fatal("seed contains more than one Typesafe provider")
			}
			found = &st.Providers[i]
		}
	}
	if found == nil {
		t.Fatal("seed is missing the Typesafe decision provider")
	}
	want := Provider{ID: "typesafe", Name: "Typesafe", BaseURL: "https://api.typesafe.ai/v1", APIKeyEnv: "TYPESAFE_API_KEY", Protocol: typesafeProtocol, CredentialRef: found.CredentialRef}
	if *found != want || found.CredentialRef == "" {
		t.Fatalf("unexpected Typesafe provider: %+v", *found)
	}
	if len(st.Draft.Groups) != 2 {
		t.Fatalf("seed groups changed: %+v", st.Draft.Groups)
	}
	for i, id := range []string{"luna", "4o"} {
		if st.Draft.Groups[i].ProviderID != id {
			t.Fatalf("generation group %d changed: %+v", i, st.Draft.Groups[i])
		}
	}
	if len(st.Metrics) != 0 || len(st.Draft.Metrics) != 0 {
		t.Fatal("seed must not create a model metric")
	}
}
