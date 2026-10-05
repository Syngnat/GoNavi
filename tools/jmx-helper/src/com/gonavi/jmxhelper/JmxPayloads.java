package com.gonavi.jmxhelper;

import static com.gonavi.jmxhelper.JmxValueConverter.inferFormat;
import static com.gonavi.jmxhelper.JmxValueConverter.toJsonCompatible;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.management.MBeanAttributeInfo;
import javax.management.MBeanOperationInfo;
import javax.management.MBeanParameterInfo;
import javax.management.ObjectName;

final class JmxPayloads {
    private JmxPayloads() {
    }

    static Map<String, Object> attributeSnapshot(
        ObjectName objectName,
        MBeanAttributeInfo attributeInfo,
        Object value
    ) {
        Object jsonValue = toJsonCompatible(value);
        boolean sensitive = isSensitiveName(attributeInfo.getName());
        List<Map<String, Object>> supportedActions = attributeInfo.isWritable()
            ? Collections.singletonList(actionDefinition(
                "set",
                "设置属性",
                "更新 JMX 属性 " + attributeInfo.getName(),
                sensitive,
                Collections.singletonList(payloadField("value", attributeInfo.getType(), true, "目标属性值")),
                sensitive ? Collections.<String, Object>emptyMap() : metadata("value", jsonValue)
            ))
            : Collections.emptyList();
        return snapshot("attribute", inferFormat(jsonValue), jsonValue, attributeInfo.getDescription(), sensitive, supportedActions, metadata(
            "objectName", objectName.toString(),
            "attribute", attributeInfo.getName(),
            "type", attributeInfo.getType(),
            "readable", attributeInfo.isReadable(),
            "writable", attributeInfo.isWritable(),
            "description", attributeInfo.getDescription()
        ));
    }

    static Map<String, Object> operationSnapshot(ObjectName objectName, MBeanOperationInfo operationInfo) {
        List<String> signature = signatureOf(operationInfo);
        List<Map<String, Object>> supportedActions = Collections.singletonList(actionDefinition(
            "invoke",
            "调用操作",
            "执行 JMX 操作 " + displayOperationName(operationInfo),
            operationInfo.getImpact() != MBeanOperationInfo.INFO,
            Arrays.asList(
                payloadField("args", "array", false, "按签名顺序传入参数值"),
                payloadField("signature", "array", false, "可选，显式指定方法签名")
            ),
            metadata("args", defaultArguments(signature), "signature", signature)
        ));
        return snapshot("operation", "json", metadata(
            "returnType", operationInfo.getReturnType(),
            "impact", impactLabel(operationInfo.getImpact()),
            "signature", signature,
            "description", operationInfo.getDescription()
        ), operationInfo.getDescription(), false, supportedActions, metadata(
            "objectName", objectName.toString(),
            "operation", operationInfo.getName(),
            "signature", signature
        ));
    }

    static List<String> signatureOf(MBeanOperationInfo operation) {
        List<String> signature = new ArrayList<>();
        for (MBeanParameterInfo parameter : operation.getSignature()) {
            signature.add(parameter.getType());
        }
        return signature;
    }

    static String displayOperationName(MBeanOperationInfo operation) {
        return operation.getName() + "(" + String.join(",", signatureOf(operation)) + ")";
    }

    static String impactLabel(int impact) {
        switch (impact) {
            case MBeanOperationInfo.INFO:
                return "INFO";
            case MBeanOperationInfo.ACTION:
                return "ACTION";
            case MBeanOperationInfo.ACTION_INFO:
                return "ACTION_INFO";
            case MBeanOperationInfo.UNKNOWN:
            default:
                return "UNKNOWN";
        }
    }

    static boolean isSensitiveName(String name) {
        String lowered = name == null ? "" : name.trim().toLowerCase(Locale.ROOT);
        return lowered.contains("password")
            || lowered.contains("secret")
            || lowered.contains("token")
            || lowered.contains("credential")
            || lowered.contains("apikey")
            || lowered.contains("api_key")
            || lowered.contains("accesskey")
            || lowered.contains("access_key")
            || lowered.contains("privatekey")
            || lowered.contains("private_key")
            || lowered.contains("secretkey")
            || lowered.contains("secret_key")
            || lowered.contains("authkey")
            || lowered.contains("auth_key");
    }

    static Map<String, Object> preview(
        boolean allowed,
        boolean requiresConfirmation,
        String summary,
        String riskLevel,
        String blockingReason,
        Map<String, Object> before,
        Map<String, Object> after
    ) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        result.put("allowed", allowed);
        if (requiresConfirmation) {
            result.put("requiresConfirmation", true);
        }
        result.put("summary", summary);
        result.put("riskLevel", riskLevel);
        if (blockingReason != null && !blockingReason.isEmpty()) {
            result.put("blockingReason", blockingReason);
        }
        if (before != null) {
            result.put("before", before);
        }
        if (after != null) {
            result.put("after", after);
        }
        return result;
    }

    static Map<String, Object> snapshot(String kind, String format, Object value, Map<String, Object> metadata) {
        return snapshot(kind, format, value, "", false, Collections.emptyList(), metadata);
    }

    static Map<String, Object> snapshot(
        String kind,
        String format,
        Object value,
        String description,
        boolean sensitive,
        List<Map<String, Object>> supportedActions,
        Map<String, Object> metadata
    ) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        result.put("kind", kind);
        result.put("format", format);
        result.put("value", value);
        if (description != null && !description.isEmpty()) {
            result.put("description", description);
        }
        if (sensitive) {
            result.put("sensitive", true);
        }
        if (supportedActions != null && !supportedActions.isEmpty()) {
            result.put("supportedActions", supportedActions);
        }
        if (metadata != null && !metadata.isEmpty()) {
            result.put("metadata", metadata);
        }
        return result;
    }

    static Map<String, Object> actionDefinition(
        String action,
        String label,
        String description,
        boolean dangerous,
        List<Map<String, Object>> payloadFields,
        Map<String, Object> payloadExample
    ) {
        return metadata(
            "action", action,
            "label", label,
            "description", description,
            "dangerous", dangerous,
            "payloadFields", payloadFields,
            "payloadExample", payloadExample
        );
    }

    static Map<String, Object> payloadField(String name, String type, boolean required, String description) {
        return metadata("name", name, "type", type, "required", required, "description", description);
    }

    static List<Object> defaultArguments(List<String> signature) {
        List<Object> values = new ArrayList<>();
        for (String type : signature) {
            switch (type) {
                case "boolean":
                case "java.lang.Boolean":
                    values.add(Boolean.FALSE);
                    break;
                case "int":
                case "java.lang.Integer":
                case "long":
                case "java.lang.Long":
                case "double":
                case "java.lang.Double":
                case "float":
                case "java.lang.Float":
                case "short":
                case "java.lang.Short":
                case "byte":
                case "java.lang.Byte":
                    values.add(0);
                    break;
                default:
                    values.add("");
                    break;
            }
        }
        return values;
    }

    static Map<String, Object> resource(
        String kind,
        String domain,
        String objectName,
        String attribute,
        String operation,
        List<String> signature,
        String name,
        boolean canRead,
        boolean canWrite,
        boolean hasChildren,
        boolean sensitive
    ) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        result.put("kind", kind);
        if (domain != null && !domain.isEmpty()) {
            result.put("domain", domain);
        }
        if (objectName != null && !objectName.isEmpty()) {
            result.put("objectName", objectName);
        }
        if (attribute != null && !attribute.isEmpty()) {
            result.put("attribute", attribute);
        }
        if (operation != null && !operation.isEmpty()) {
            result.put("operation", operation);
        }
        if (signature != null && !signature.isEmpty()) {
            result.put("signature", signature);
        }
        result.put("name", name);
        result.put("canRead", canRead);
        result.put("canWrite", canWrite);
        result.put("hasChildren", hasChildren);
        if (sensitive) {
            result.put("sensitive", true);
        }
        return result;
    }

    static Map<String, Object> singleton(String key, Object value) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        result.put(key, value);
        return result;
    }

    static void addUnique(List<String> items, String value) {
        if (value == null || value.isEmpty() || items.contains(value)) {
            return;
        }
        items.add(value);
    }

    static Map<String, Object> metadata(Object... pairs) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) {
            if (pairs[index + 1] == null) {
                continue;
            }
            result.put(String.valueOf(pairs[index]), pairs[index + 1]);
        }
        return result;
    }

    static Map<String, Object> attributeInfoValue(MBeanAttributeInfo attribute) {
        return metadata(
            "name", attribute.getName(),
            "type", attribute.getType(),
            "description", attribute.getDescription(),
            "readable", attribute.isReadable(),
            "writable", attribute.isWritable()
        );
    }

    static Map<String, Object> operationInfoValue(MBeanOperationInfo operation) {
        return metadata(
            "name", operation.getName(),
            "displayName", displayOperationName(operation),
            "returnType", operation.getReturnType(),
            "impact", impactLabel(operation.getImpact()),
            "signature", signatureOf(operation)
        );
    }
}
