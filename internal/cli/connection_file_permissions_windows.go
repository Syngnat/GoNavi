//go:build windows

package cli

import (
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

func validateConnectionFilePermissions(file *os.File, _ os.FileMode) error {
	if file == nil {
		return errors.New("connection file handle is unavailable for ACL validation")
	}
	securityDescriptor, err := windows.GetSecurityInfo(
		windows.Handle(file.Fd()),
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return fmt.Errorf("read connection file ACL: %w", err)
	}
	owner, _, err := securityDescriptor.Owner()
	if err != nil || owner == nil {
		return errors.New("connection file ACL has no verifiable owner")
	}
	currentUser, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || currentUser == nil || currentUser.User.Sid == nil {
		return errors.New("connection file owner could not be compared with the current user")
	}
	if !owner.Equals(currentUser.User.Sid) {
		return errors.New("connection file must be owned by the current user")
	}
	dacl, _, err := securityDescriptor.DACL()
	if err != nil {
		return fmt.Errorf("read connection file DACL: %w", err)
	}
	if dacl == nil {
		return errors.New("connection file ACL grants unrestricted access")
	}

	localSystem, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return fmt.Errorf("resolve LocalSystem SID: %w", err)
	}
	administrators, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return fmt.Errorf("resolve Administrators SID: %w", err)
	}
	allowedReaders := []*windows.SID{owner, localSystem, administrators}
	readMask := windows.ACCESS_MASK(windows.GENERIC_READ | windows.GENERIC_ALL | windows.FILE_READ_DATA | windows.FILE_READ_EA)

	for index := uint16(0); index < dacl.AceCount; index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, uint32(index), &ace); err != nil {
			return fmt.Errorf("read connection file ACL entry %d: %w", index, err)
		}
		if ace == nil || ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE || ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			continue
		}
		if ace.Mask&readMask == 0 {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("connection file ACL contains an unsupported read grant")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		allowed := false
		for _, candidate := range allowedReaders {
			if sid.Equals(candidate) {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("connection file ACL grants read access to %s", sid.String())
		}
	}
	return nil
}
