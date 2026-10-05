package com.gonavi.jmxhelper;

import java.util.List;
import java.util.Map;

final class JmxRequestValues {
    private JmxRequestValues() {
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> requiredObject(Object value, String label) {
        if (value instanceof Map<?, ?>) {
            return (Map<String, Object>) value;
        }
        throw new IllegalArgumentException(label + " must be a JSON object");
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> optionalObject(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Map<?, ?>) {
            return (Map<String, Object>) value;
        }
        throw new IllegalArgumentException("expected JSON object");
    }

    @SuppressWarnings("unchecked")
    static List<Object> requiredArray(Object value, String label) {
        if (value instanceof List<?>) {
            return (List<Object>) value;
        }
        throw new IllegalArgumentException(label + " must be a JSON array");
    }

    static String requiredString(Object value, String label) {
        if (value == null) {
            throw new IllegalArgumentException(label + " is required");
        }
        String text = String.valueOf(value).trim();
        if (text.isEmpty()) {
            throw new IllegalArgumentException(label + " is required");
        }
        return text;
    }

    static int integerValue(Object value, String label) {
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        String text = requiredString(value, label);
        if (text.endsWith(".0")) {
            text = text.substring(0, text.length() - 2);
        }
        return Integer.parseInt(text);
    }
}
