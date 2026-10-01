package dbuser

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"
)

// 属性字段 ID。与 option_contract.json 一一对应；前端同源导入该 JSON，
// 并用测试保证每个 ID 都有文案，新增字段必须同时改 JSON、此处常量与文案。
const (
	OptCanLogin               = "canLogin"
	OptAccountLocked          = "accountLocked"
	OptLoginEnabled           = "loginEnabled"
	OptExpirePasswordNow      = "expirePasswordNow"
	OptAuthPlugin             = "authPlugin"
	OptAuthType               = "authType"
	OptPasswordEncryption     = "passwordEncryption"
	OptMechanisms             = "mechanisms"
	OptComment                = "comment"
	OptValidUntil             = "validUntil"
	OptValidBegin             = "validBegin"
	OptConnectionLimit        = "connectionLimit"
	OptPasswordExpirePolicy   = "passwordExpirePolicy"
	OptPasswordLifetimeDays   = "passwordLifetimeDays"
	OptPasswordHistory        = "passwordHistory"
	OptPasswordReuseDays      = "passwordReuseDays"
	OptPasswordRequireCurrent = "passwordRequireCurrent"
	OptFailedLoginAttempts    = "failedLoginAttempts"
	OptPasswordLockDays       = "passwordLockDays"
	OptMaxQueriesPerHour      = "maxQueriesPerHour"
	OptMaxUpdatesPerHour      = "maxUpdatesPerHour"
	OptMaxConnectionsPerHour  = "maxConnectionsPerHour"
	OptMaxUserConnections     = "maxUserConnections"
	OptRequireSSL             = "requireSsl"
	OptSuperuser              = "superuser"
	OptCreateDB               = "createDb"
	OptCreateRole             = "createRole"
	OptInherit                = "inherit"
	OptReplication            = "replication"
	OptBypassRLS              = "bypassRls"
	OptSysAdmin               = "sysAdmin"
	OptAuditAdmin             = "auditAdmin"
	OptMonAdmin               = "monAdmin"
	OptOprAdmin               = "oprAdmin"
	OptPolAdmin               = "polAdmin"
	OptLoginType              = "loginType"
	OptCheckPolicy            = "checkPolicy"
	OptCheckExpiration        = "checkExpiration"
	OptMustChange             = "mustChange"
	OptDefaultDatabase        = "defaultDatabase"
	OptDefaultLanguage        = "defaultLanguage"
	OptDBUserType             = "dbUserType"
	OptLoginName              = "loginName"
	OptDefaultSchema          = "defaultSchema"
	OptDefaultTablespace      = "defaultTablespace"
	OptTemporaryTablespace    = "temporaryTablespace"
	OptTablespaceQuota        = "tablespaceQuota"
	OptProfile                = "profile"
	OptNoAuthentication       = "noAuthentication"
	OptCaseSensitiveName      = "caseSensitiveName"
	OptHosts                  = "hosts"
	OptSettingsProfile        = "settingsProfile"
	OptOnCluster              = "onCluster"
	OptSysInfo                = "sysInfo"
	OptPrivilegeLevel         = "privilegeLevel"
	OptCustomData             = "customData"
	OptClientSources          = "clientSources"
	OptServerAddresses        = "serverAddresses"
	OptNoPass                 = "noPass"
	OptACLKeys                = "aclKeys"
	OptACLChannels            = "aclChannels"
	OptACLCommands            = "aclCommands"
	OptACLSelectors           = "aclSelectors"
	OptACLPersist             = "aclPersist"
	OptDefaultRoles           = "defaultRoles"
)

//go:embed option_contract.json
var optionContractJSON []byte

type optionContract struct {
	Version int                   `json:"version"`
	Options map[string]OptionType `json:"options"`
}

var (
	optionContractOnce  sync.Once
	optionContractTypes map[string]OptionType
	optionContractErr   error
)

func loadOptionContract() (map[string]OptionType, error) {
	optionContractOnce.Do(func() {
		var contract optionContract
		if err := json.Unmarshal(optionContractJSON, &contract); err != nil {
			optionContractErr = fmt.Errorf("dbuser: invalid option contract: %w", err)
			return
		}
		optionContractTypes = contract.Options
	})
	return optionContractTypes, optionContractErr
}

// CheckDescriptorsAgainstContract 校验 Provider 声明的字段都在契约中且类型一致；
// 供各 Provider 的单测调用，防止前后端字段漂移。
func CheckDescriptorsAgainstContract(descriptors []OptionDescriptor) error {
	contractTypes, err := loadOptionContract()
	if err != nil {
		return err
	}
	for _, descriptor := range descriptors {
		contractType, ok := contractTypes[descriptor.ID]
		if !ok {
			return fmt.Errorf("option %q missing from option_contract.json", descriptor.ID)
		}
		if contractType != descriptor.Type {
			return fmt.Errorf("option %q type %q differs from contract %q", descriptor.ID, descriptor.Type, contractType)
		}
	}
	return nil
}

// BoolOption 构造布尔字段描述。
func BoolOption(id, tab string, kinds ...PrincipalKind) OptionDescriptor {
	return OptionDescriptor{ID: id, Type: OptionBool, Tab: tab, Kinds: kinds}
}

// IntOption 构造整数字段描述。
func IntOption(id, tab string, min, max int, kinds ...PrincipalKind) OptionDescriptor {
	return OptionDescriptor{ID: id, Type: OptionInt, Tab: tab, Min: min, Max: max, Kinds: kinds}
}

// StringOption 构造字符串字段描述。
func StringOption(id, tab string, kinds ...PrincipalKind) OptionDescriptor {
	return OptionDescriptor{ID: id, Type: OptionString, Tab: tab, Kinds: kinds}
}

// EnumOption 构造枚举字段描述。
func EnumOption(id, tab string, choices []Choice, kinds ...PrincipalKind) OptionDescriptor {
	return OptionDescriptor{ID: id, Type: OptionEnum, Tab: tab, Choices: choices, Kinds: kinds}
}

// Choices 以值列表构造候选项。
func Choices(values ...string) []Choice {
	choices := make([]Choice, 0, len(values))
	for _, value := range values {
		choices = append(choices, Choice{Value: value})
	}
	return choices
}

// Notef 构造提示。
func Notef(code, level string, pairs ...string) Notice {
	notice := Notice{Code: code, Level: level}
	if len(pairs) > 1 {
		notice.Params = make(map[string]string, len(pairs)/2)
		for index := 0; index+1 < len(pairs); index += 2 {
			notice.Params[pairs[index]] = pairs[index+1]
		}
	}
	return notice
}
