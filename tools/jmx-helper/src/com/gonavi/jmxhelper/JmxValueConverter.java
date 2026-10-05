package com.gonavi.jmxhelper;

import static com.gonavi.jmxhelper.JmxPayloads.signatureOf;
import static com.gonavi.jmxhelper.JmxRequestValues.requiredArray;
import static com.gonavi.jmxhelper.JmxRequestValues.requiredString;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import javax.management.MBeanOperationInfo;
import javax.management.ObjectName;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.TabularData;

final class JmxValueConverter {
    private JmxValueConverter() {
    }

    static List<Object> argumentList(Map<String, Object> payload) {
        if (payload == null) {
            return Collections.emptyList();
        }
        if (payload.containsKey("args")) {
            return requiredArray(payload.get("args"), "payload.args");
        }
        if (payload.containsKey("arguments")) {
            return requiredArray(payload.get("arguments"), "payload.arguments");
        }
        return Collections.emptyList();
    }

    static String[] effectiveSignature(
        TargetSpec target,
        Map<String, Object> payload,
        MBeanOperationInfo operationInfo
    ) {
        if (target.signature != null && !target.signature.isEmpty()) {
            return target.signature.toArray(new String[0]);
        }
        if (payload != null && payload.containsKey("signature")) {
            List<Object> raw = requiredArray(payload.get("signature"), "payload.signature");
            String[] signature = new String[raw.size()];
            for (int index = 0; index < raw.size(); index++) {
                signature[index] = requiredString(raw.get(index), "payload.signature[" + index + "]");
            }
            return signature;
        }
        return signatureOf(operationInfo).toArray(new String[0]);
    }

    static Object[] convertArguments(List<Object> args, String[] signature) throws Exception {
        if (args.size() != signature.length) {
            throw new IllegalArgumentException(
                "operation arguments do not match signature length: got " + args.size() + ", expected " + signature.length
            );
        }
        Object[] converted = new Object[signature.length];
        for (int index = 0; index < signature.length; index++) {
            converted[index] = convertValue(args.get(index), signature[index]);
        }
        return converted;
    }

    static Object convertValue(Object raw, String targetType) throws Exception {
        String normalized = targetType == null ? "" : targetType.trim();
        switch (normalized) {
            case "java.lang.String":
            case "String":
                return raw == null ? null : String.valueOf(raw);
            case "boolean":
            case "java.lang.Boolean":
                return toBoolean(raw);
            case "int":
            case "java.lang.Integer":
                return toNumber(raw).intValue();
            case "long":
            case "java.lang.Long":
                return toNumber(raw).longValue();
            case "double":
            case "java.lang.Double":
                return toNumber(raw).doubleValue();
            case "float":
            case "java.lang.Float":
                return toNumber(raw).floatValue();
            case "short":
            case "java.lang.Short":
                return toNumber(raw).shortValue();
            case "byte":
            case "java.lang.Byte":
                return toNumber(raw).byteValue();
            case "javax.management.ObjectName":
                return new ObjectName(requiredString(raw, "objectName value"));
            default:
                if (normalized.endsWith("[]")) {
                    return convertArrayValue(raw, normalized.substring(0, normalized.length() - 2));
                }
                if (raw == null) {
                    return null;
                }
                if (normalized.isEmpty() || "java.lang.Object".equals(normalized) || "Object".equals(normalized)) {
                    return raw;
                }
                throw new IllegalArgumentException("unsupported JMX argument type: " + normalized);
        }
    }

    static Object convertArrayValue(Object raw, String elementType) throws Exception {
        List<Object> items = requiredArray(raw, "array value");
        switch (elementType) {
            case "java.lang.String":
            case "String": {
                String[] result = new String[items.size()];
                for (int index = 0; index < items.size(); index++) {
                    result[index] = requiredString(items.get(index), "array[" + index + "]");
                }
                return result;
            }
            case "int": {
                int[] result = new int[items.size()];
                for (int index = 0; index < items.size(); index++) {
                    result[index] = toNumber(items.get(index)).intValue();
                }
                return result;
            }
            case "long": {
                long[] result = new long[items.size()];
                for (int index = 0; index < items.size(); index++) {
                    result[index] = toNumber(items.get(index)).longValue();
                }
                return result;
            }
            case "boolean": {
                boolean[] result = new boolean[items.size()];
                for (int index = 0; index < items.size(); index++) {
                    result[index] = toBoolean(items.get(index));
                }
                return result;
            }
            default:
                throw new IllegalArgumentException("unsupported JMX array type: " + elementType + "[]");
        }
    }

    static boolean toBoolean(Object raw) {
        if (raw instanceof Boolean) {
            return (Boolean) raw;
        }
        if (raw instanceof Number) {
            return ((Number) raw).intValue() != 0;
        }
        String text = requiredString(raw, "boolean value").trim().toLowerCase(Locale.ROOT);
        if ("true".equals(text) || "1".equals(text)) {
            return true;
        }
        if ("false".equals(text) || "0".equals(text)) {
            return false;
        }
        throw new IllegalArgumentException("invalid boolean value: " + raw);
    }

    static Number toNumber(Object raw) {
        if (raw instanceof Number) {
            return (Number) raw;
        }
        String text = requiredString(raw, "numeric value").trim();
        if (text.contains(".") || text.contains("e") || text.contains("E")) {
            return Double.valueOf(text);
        }
        return Long.valueOf(text);
    }

    static Object toJsonCompatible(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof String || value instanceof Number || value instanceof Boolean) {
            return value;
        }
        if (value instanceof Character) {
            return String.valueOf(value);
        }
        if (value instanceof Enum<?>) {
            return ((Enum<?>) value).name();
        }
        if (value instanceof ObjectName) {
            return ((ObjectName) value).getCanonicalName();
        }
        if (value instanceof Date) {
            return ((Date) value).toInstant().toString();
        }
        if (value instanceof CompositeData) {
            CompositeData composite = (CompositeData) value;
            TreeMap<String, Object> result = new TreeMap<>();
            for (String key : composite.getCompositeType().keySet()) {
                result.put(key, toJsonCompatible(composite.get(key)));
            }
            return result;
        }
        if (value instanceof TabularData) {
            TabularData table = (TabularData) value;
            List<Object> result = new ArrayList<>();
            for (Object entry : table.values()) {
                result.add(toJsonCompatible(entry));
            }
            return result;
        }
        if (value instanceof Map<?, ?>) {
            TreeMap<String, Object> result = new TreeMap<>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                result.put(String.valueOf(entry.getKey()), toJsonCompatible(entry.getValue()));
            }
            return result;
        }
        if (value instanceof Collection<?>) {
            List<Object> result = new ArrayList<>();
            for (Object item : (Collection<?>) value) {
                result.add(toJsonCompatible(item));
            }
            return result;
        }
        if (value.getClass().isArray()) {
            int length = java.lang.reflect.Array.getLength(value);
            List<Object> result = new ArrayList<>(length);
            for (int index = 0; index < length; index++) {
                result.add(toJsonCompatible(java.lang.reflect.Array.get(value, index)));
            }
            return result;
        }
        return String.valueOf(value);
    }

    static String inferFormat(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof String) {
            return "string";
        }
        if (value instanceof Number) {
            return "number";
        }
        if (value instanceof Boolean) {
            return "boolean";
        }
        if (value instanceof List<?>) {
            return "array";
        }
        return "json";
    }
}
