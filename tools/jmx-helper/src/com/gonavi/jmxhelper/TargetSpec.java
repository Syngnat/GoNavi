package com.gonavi.jmxhelper;

import static com.gonavi.jmxhelper.JmxRequestValues.requiredArray;
import static com.gonavi.jmxhelper.JmxRequestValues.requiredString;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

final class TargetSpec {
    final String kind;
    final String domain;
    final String objectName;
    final String attribute;
    final String operation;
    final List<String> signature;

    private TargetSpec(
        String kind,
        String domain,
        String objectName,
        String attribute,
        String operation,
        List<String> signature
    ) {
        this.kind = kind == null ? "root" : kind;
        this.domain = domain == null ? "" : domain;
        this.objectName = objectName == null ? "" : objectName;
        this.attribute = attribute == null ? "" : attribute;
        this.operation = operation == null ? "" : operation;
        this.signature = signature == null ? Collections.emptyList() : signature;
    }

    static TargetSpec from(Map<String, Object> source) {
        if (source == null) {
            return null;
        }
        List<String> signature = new ArrayList<>();
        if (source.get("signature") instanceof List<?>) {
            for (Object item : requiredArray(source.get("signature"), "target.signature")) {
                signature.add(requiredString(item, "target.signature item"));
            }
        }
        return new TargetSpec(
            source.get("kind") == null ? "root" : String.valueOf(source.get("kind")).trim(),
            source.get("domain") == null ? "" : String.valueOf(source.get("domain")).trim(),
            source.get("objectName") == null ? "" : String.valueOf(source.get("objectName")).trim(),
            source.get("attribute") == null ? "" : String.valueOf(source.get("attribute")).trim(),
            source.get("operation") == null ? "" : String.valueOf(source.get("operation")).trim(),
            signature
        );
    }

    boolean isRoot() {
        return kind.isEmpty() || "root".equals(kind);
    }

    boolean isDomain() {
        return "domain".equals(kind);
    }

    boolean isMBean() {
        return "mbean".equals(kind);
    }

    boolean isAttribute() {
        return "attribute".equals(kind);
    }

    boolean isOperation() {
        return "operation".equals(kind);
    }
}
