//go:build darwin && cgo

package app

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#import <dispatch/dispatch.h>

static int gonaviSetApplicationIconFromPNG(const void *data, int length) {
	if (data == NULL || length <= 0) {
		return 0;
	}
	NSData *pngData = [NSData dataWithBytes:data length:(NSUInteger)length];
	if (pngData == nil) {
		return 0;
	}
	NSImage *image = [[NSImage alloc] initWithData:pngData];
	if (image == nil) {
		return 0;
	}
	dispatch_async(dispatch_get_main_queue(), ^{
		[NSApp setApplicationIconImage:image];
		[image release];
	});
	return 1;
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

func setApplicationIconPNG(png []byte) error {
	if len(png) == 0 {
		return errors.New("application icon PNG is empty")
	}
	if C.gonaviSetApplicationIconFromPNG(unsafe.Pointer(&png[0]), C.int(len(png))) == 0 {
		return errors.New("failed to create macOS application icon image")
	}
	return nil
}
