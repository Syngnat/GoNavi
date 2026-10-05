package webserver

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
)

type methodInvoker struct {
	targets             map[string]reflect.Value
	contextHandlers     map[string]map[string]reflect.Value
	allowDesktopMethods bool
}

func newMethodInvoker(app *appcore.App, ai *aiservice.Service) (*methodInvoker, error) {
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{
			"app.app":           reflect.ValueOf(app),
			"app":               reflect.ValueOf(app),
			"aiservice.service": reflect.ValueOf(ai),
			"aiservice":         reflect.ValueOf(ai),
		},
	}
	appHandlers, err := validateContextHandlers(
		reflect.ValueOf(app),
		appcore.RequiredIssue1098WebRPCContextMethods(),
		appcore.WebRPCContextHandlers(app),
	)
	if err != nil {
		return nil, fmt.Errorf("validate App Web RPC context handlers: %w", err)
	}
	invoker.contextHandlers = map[string]map[string]reflect.Value{"app": appHandlers}
	return invoker, nil
}

func validateContextHandlers(target reflect.Value, required []string, handlers map[string]any) (map[string]reflect.Value, error) {
	if !target.IsValid() || (target.Kind() == reflect.Pointer && target.IsNil()) {
		return nil, fmt.Errorf("context handler target is unavailable")
	}
	requiredSet := make(map[string]struct{}, len(required))
	for _, methodName := range required {
		methodName = strings.TrimSpace(methodName)
		if methodName == "" {
			return nil, fmt.Errorf("required context method name is empty")
		}
		if _, exists := requiredSet[methodName]; exists {
			return nil, fmt.Errorf("required context method %s is duplicated", methodName)
		}
		requiredSet[methodName] = struct{}{}
	}
	if len(handlers) != len(requiredSet) {
		return nil, fmt.Errorf("context handler count mismatch: want %d got %d", len(requiredSet), len(handlers))
	}

	contextType := reflect.TypeOf((*context.Context)(nil)).Elem()
	validated := make(map[string]reflect.Value, len(handlers))
	for methodName, rawHandler := range handlers {
		if _, required := requiredSet[methodName]; !required {
			return nil, fmt.Errorf("context handler %s is not in the required method set", methodName)
		}
		publicMethod := target.MethodByName(methodName)
		if !publicMethod.IsValid() {
			return nil, fmt.Errorf("public method %s does not exist", methodName)
		}
		publicType := publicMethod.Type()
		if publicType.IsVariadic() {
			return nil, fmt.Errorf("public method %s must not be variadic", methodName)
		}

		handler := reflect.ValueOf(rawHandler)
		if !handler.IsValid() || handler.Kind() != reflect.Func || handler.IsNil() {
			return nil, fmt.Errorf("context handler %s must be a non-nil function", methodName)
		}
		handlerType := handler.Type()
		if handlerType.IsVariadic() {
			return nil, fmt.Errorf("context handler %s must not be variadic", methodName)
		}
		if handlerType.NumIn() != publicType.NumIn()+1 || handlerType.In(0) != contextType {
			return nil, fmt.Errorf("context handler %s has an invalid parameter list", methodName)
		}
		for index := 0; index < publicType.NumIn(); index++ {
			if handlerType.In(index+1) != publicType.In(index) {
				return nil, fmt.Errorf("context handler %s parameter %d type mismatch", methodName, index)
			}
		}
		if handlerType.NumOut() != publicType.NumOut() {
			return nil, fmt.Errorf("context handler %s return count mismatch", methodName)
		}
		for index := 0; index < publicType.NumOut(); index++ {
			if handlerType.Out(index) != publicType.Out(index) {
				return nil, fmt.Errorf("context handler %s return %d type mismatch", methodName, index)
			}
		}
		validated[methodName] = handler
	}
	for methodName := range requiredSet {
		if _, exists := validated[methodName]; !exists {
			return nil, fmt.Errorf("required context handler %s is missing", methodName)
		}
	}
	return validated, nil
}

func canonicalInvokeTarget(key string) string {
	switch key {
	case "app", "app.app":
		return "app"
	case "aiservice", "aiservice.service":
		return "aiservice"
	default:
		return key
	}
}

func (i *methodInvoker) Invoke(ctx context.Context, req invokeRequest) (any, error) {
	if i == nil {
		return nil, fmt.Errorf("web invoker is not initialized")
	}
	namespace := strings.ToLower(strings.TrimSpace(req.Namespace))
	receiver := strings.ToLower(strings.TrimSpace(req.Receiver))
	methodName := strings.TrimSpace(req.Method)
	if namespace == "" || methodName == "" {
		return nil, fmt.Errorf("invalid invoke request")
	}

	key := namespace
	if receiver != "" {
		key = namespace + "." + receiver
	}
	target, ok := i.targets[key]
	if !ok {
		return nil, fmt.Errorf("unsupported invoke target: %s.%s", namespace, receiver)
	}
	if !i.allowDesktopMethods && (key == "app" || key == "app.app") && isDesktopOnlyAppMethod(methodName) {
		return nil, fmt.Errorf("method %s is unavailable in web runtime", methodName)
	}

	method := target.MethodByName(methodName)
	if !method.IsValid() {
		return nil, fmt.Errorf("unsupported method: %s.%s.%s", namespace, receiver, methodName)
	}

	methodType := method.Type()
	if methodType.IsVariadic() {
		return nil, fmt.Errorf("variadic methods are not supported: %s", methodName)
	}
	if methodType.NumIn() != len(req.Args) {
		return nil, fmt.Errorf("invalid argument count for %s: want %d got %d", methodName, methodType.NumIn(), len(req.Args))
	}

	callArgs := make([]reflect.Value, 0, len(req.Args))
	for index, raw := range req.Args {
		argValue, err := decodeArgument(raw, methodType.In(index))
		if err != nil {
			return nil, fmt.Errorf("decode argument %d for %s failed: %w", index, methodName, err)
		}
		callArgs = append(callArgs, argValue)
	}

	canonicalTarget := canonicalInvokeTarget(key)
	handler := reflect.Value{}
	if handlers := i.contextHandlers[canonicalTarget]; handlers != nil {
		handler = handlers[methodName]
	}
	if handler.IsValid() {
		if ctx == nil {
			ctx = context.Background()
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		contextCallArgs := make([]reflect.Value, 0, len(callArgs)+1)
		contextCallArgs = append(contextCallArgs, reflect.ValueOf(ctx))
		contextCallArgs = append(contextCallArgs, callArgs...)
		return unpackResults(handler.Call(contextCallArgs))
	}

	results := method.Call(callArgs)
	return unpackResults(results)
}

func isDesktopOnlyAppMethod(methodName string) bool {
	methodName = strings.TrimSpace(methodName)
	if _, denied := desktopOnlyAppMethods[methodName]; denied {
		return true
	}
	_, denied := desktopOnlyCredentialAppMethods[methodName]
	return denied
}

func decodeArgument(raw json.RawMessage, targetType reflect.Type) (reflect.Value, error) {
	holder := reflect.New(targetType)
	if len(raw) == 0 {
		return holder.Elem(), nil
	}
	if err := json.Unmarshal(raw, holder.Interface()); err != nil {
		return reflect.Value{}, err
	}
	return holder.Elem(), nil
}

func unpackResults(results []reflect.Value) (any, error) {
	if len(results) == 0 {
		return nil, nil
	}

	last := results[len(results)-1]
	if last.IsValid() && last.Type().Implements(errorType) {
		if !last.IsNil() {
			return nil, last.Interface().(error)
		}
		results = results[:len(results)-1]
	}

	switch len(results) {
	case 0:
		return nil, nil
	case 1:
		return results[0].Interface(), nil
	default:
		unpacked := make([]any, len(results))
		for index := range results {
			unpacked[index] = results[index].Interface()
		}
		return unpacked, nil
	}
}
