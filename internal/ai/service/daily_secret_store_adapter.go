package aiservice

import (
	stdRuntime "runtime"

	"GoNavi-Wails/internal/dailysecret"
	"GoNavi-Wails/internal/secretstore"
)

var aiRuntimeGOOS = func() string {
	return stdRuntime.GOOS
}

func (s *Service) dailySecretStore() *dailysecret.Store {
	return dailysecret.NewStore(s.configDir)
}

// newDefaultAISecretStore intentionally does not even open the macOS
// Keychain backend. AI secrets are stored in the local 0600 daily-secret file,
// and reading legacy Keychain items would require a user authorization prompt.
func newDefaultAISecretStore() secretstore.SecretStore {
	if aiRuntimeGOOS() == "darwin" {
		return secretstore.NewUnavailableStore("AI secrets use local storage on macOS")
	}
	return secretstore.NewKeyringStore()
}

func shouldReadLegacyProviderSecretStore() bool {
	return aiRuntimeGOOS() != "darwin"
}
