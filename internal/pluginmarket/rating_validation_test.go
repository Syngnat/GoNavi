package pluginmarket

import (
	"strings"
	"testing"
)

func TestValidRatingUserName(t *testing.T) {
	base := Rating{UserID: "user", PluginID: "publisher.plugin", Stars: 4, Body: "review"}
	if !validRating(base, base.PluginID) {
		t.Fatal("rating without a user name must remain valid")
	}
	base.UserName = "octocat"
	if !validRating(base, base.PluginID) {
		t.Fatal("rating with a user name must be valid")
	}
	base.UserName = strings.Repeat("x", 257)
	if validRating(base, base.PluginID) {
		t.Fatal("an oversized user name must be rejected")
	}
}
