package com.gonavi.jmxhelper;

import static com.gonavi.jmxhelper.JmxMonitoringSnapshot.getMonitoringSnapshot;
import static com.gonavi.jmxhelper.JmxPayloads.attributeInfoValue;
import static com.gonavi.jmxhelper.JmxPayloads.attributeSnapshot;
import static com.gonavi.jmxhelper.JmxPayloads.displayOperationName;
import static com.gonavi.jmxhelper.JmxPayloads.isSensitiveName;
import static com.gonavi.jmxhelper.JmxPayloads.metadata;
import static com.gonavi.jmxhelper.JmxPayloads.operationInfoValue;
import static com.gonavi.jmxhelper.JmxPayloads.operationSnapshot;
import static com.gonavi.jmxhelper.JmxPayloads.preview;
import static com.gonavi.jmxhelper.JmxPayloads.resource;
import static com.gonavi.jmxhelper.JmxPayloads.signatureOf;
import static com.gonavi.jmxhelper.JmxPayloads.singleton;
import static com.gonavi.jmxhelper.JmxPayloads.snapshot;
import static com.gonavi.jmxhelper.JmxRequestValues.optionalObject;
import static com.gonavi.jmxhelper.JmxRequestValues.requiredObject;
import static com.gonavi.jmxhelper.JmxRequestValues.requiredString;
import static com.gonavi.jmxhelper.JmxValueConverter.argumentList;
import static com.gonavi.jmxhelper.JmxValueConverter.convertArguments;
import static com.gonavi.jmxhelper.JmxValueConverter.convertValue;
import static com.gonavi.jmxhelper.JmxValueConverter.effectiveSignature;
import static com.gonavi.jmxhelper.JmxValueConverter.toJsonCompatible;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.management.Attribute;
import javax.management.AttributeNotFoundException;
import javax.management.MBeanAttributeInfo;
import javax.management.MBeanInfo;
import javax.management.MBeanOperationInfo;
import javax.management.MBeanServerConnection;
import javax.management.ObjectName;
import javax.management.remote.JMXConnector;
import javax.management.remote.JMXConnectorFactory;
import javax.management.remote.JMXServiceURL;

final class JmxRuntime {
    private JmxRuntime() {
    }

    static Map<String, Object> handle(Map<String, Object> request) throws Exception {
        String command = requiredString(request.get("command"), "command");
        ConnectionSpec connection = ConnectionSpec.from(requiredObject(request.get("connection"), "connection"));
        TargetSpec target = TargetSpec.from(optionalObject(request.get("target")));
        Map<String, Object> change = optionalObject(request.get("change"));

        try (JMXConnector connector = connect(connection)) {
            MBeanServerConnection server = connector.getMBeanServerConnection();
            switch (command) {
                case "ping":
                    server.getDefaultDomain();
                    return new LinkedHashMap<>();
                case "list":
                    return listResources(server, connection, target);
                case "get":
                    return singleton("snapshot", getValue(server, connection, target));
                case "monitor":
                    return singleton("monitoringSnapshot", getMonitoringSnapshot(server, connection));
                case "preview":
                    return singleton("preview", previewChange(server, connection, target, change));
                case "apply":
                    return singleton("applyResult", applyChange(server, connection, target, change));
                default:
                    throw new IllegalArgumentException("unsupported helper command: " + command);
            }
        } catch (Exception error) {
            throw new IllegalStateException(
                "JMX command " + command + " failed for " + connection.describe() + ": " + error.getMessage(),
                error
            );
        }
    }

    private static JMXConnector connect(ConnectionSpec connection) throws Exception {
        String serviceUrl = "service:jmx:rmi:///jndi/rmi://" + connection.host + ":" + connection.port + "/jmxrmi";
        JMXServiceURL url = new JMXServiceURL(serviceUrl);
        Map<String, Object> environment = new LinkedHashMap<>();
        if (!connection.username.isEmpty()) {
            environment.put(JMXConnector.CREDENTIALS, new String[]{connection.username, connection.password});
        }
        return JMXConnectorFactory.connect(url, environment);
    }

    private static Map<String, Object> listResources(
        MBeanServerConnection server,
        ConnectionSpec connection,
        TargetSpec target
    ) throws Exception {
        List<Map<String, Object>> resources = new ArrayList<>();

        if (target == null || target.isRoot()) {
            String[] domains = server.getDomains();
            Arrays.sort(domains);
            for (String domain : domains) {
                if (!connection.isDomainAllowed(domain)) {
                    continue;
                }
                resources.add(resource("domain", domain, null, null, null, null, domain, true, false, true, false));
            }
            return singleton("resources", resources);
        }

        if (target.isDomain()) {
            requireDomainAllowed(connection, target.domain);
            Set<ObjectName> names = server.queryNames(new ObjectName(target.domain + ":*"), null);
            List<ObjectName> sortedNames = new ArrayList<>(names);
            Collections.sort(sortedNames, Comparator.comparing(ObjectName::getCanonicalName));
            for (ObjectName name : sortedNames) {
                resources.add(resource(
                    "mbean",
                    target.domain,
                    name.getCanonicalName(),
                    null,
                    null,
                    null,
                    name.toString(),
                    true,
                    false,
                    true,
                    false
                ));
            }
            return singleton("resources", resources);
        }

        if (target.isMBean()) {
            ObjectName objectName = new ObjectName(target.objectName);
            requireDomainAllowed(connection, objectName);
            MBeanInfo info = server.getMBeanInfo(objectName);

            MBeanAttributeInfo[] attributes = info.getAttributes();
            Arrays.sort(attributes, Comparator.comparing(MBeanAttributeInfo::getName));
            for (MBeanAttributeInfo attribute : attributes) {
                if (!attribute.isReadable() && !attribute.isWritable()) {
                    continue;
                }
                resources.add(resource(
                    "attribute",
                    domainOf(objectName),
                    objectName.getCanonicalName(),
                    attribute.getName(),
                    null,
                    null,
                    attribute.getName(),
                    attribute.isReadable(),
                    attribute.isWritable(),
                    false,
                    isSensitiveName(attribute.getName())
                ));
            }

            MBeanOperationInfo[] operations = info.getOperations();
            Arrays.sort(operations, Comparator.comparing(JmxPayloads::displayOperationName));
            for (MBeanOperationInfo operation : operations) {
                List<String> signature = signatureOf(operation);
                resources.add(resource(
                    "operation",
                    domainOf(objectName),
                    objectName.getCanonicalName(),
                    null,
                    operation.getName(),
                    signature,
                    displayOperationName(operation),
                    true,
                    true,
                    false,
                    false
                ));
            }
            return singleton("resources", resources);
        }

        throw new IllegalArgumentException("target kind " + target.kind + " does not support list");
    }

    private static Map<String, Object> getValue(
        MBeanServerConnection server,
        ConnectionSpec connection,
        TargetSpec target
    ) throws Exception {
        requireTarget(target);

        if (target.isDomain()) {
            requireDomainAllowed(connection, target.domain);
            Set<ObjectName> names = server.queryNames(new ObjectName(target.domain + ":*"), null);
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("domain", target.domain);
            value.put("mbeanCount", names.size());
            return snapshot("domain", "json", value, "JMX 域 " + target.domain, false, Collections.emptyList(), metadata("domain", target.domain));
        }

        ObjectName objectName = new ObjectName(target.objectName);
        requireDomainAllowed(connection, objectName);
        if (target.isMBean()) {
            MBeanInfo info = server.getMBeanInfo(objectName);
            List<Map<String, Object>> attributes = new ArrayList<>();
            for (MBeanAttributeInfo attribute : info.getAttributes()) {
                attributes.add(attributeInfoValue(attribute));
            }
            List<Map<String, Object>> operations = new ArrayList<>();
            for (MBeanOperationInfo operation : info.getOperations()) {
                operations.add(operationInfoValue(operation));
            }

            Map<String, Object> value = new LinkedHashMap<>();
            value.put("objectName", objectName.toString());
            value.put("className", info.getClassName());
            value.put("description", info.getDescription());
            value.put("attributes", attributes);
            value.put("operations", operations);
            return snapshot("mbean", "json", value, info.getDescription(), false, Collections.emptyList(), metadata(
                "objectName", objectName.toString(),
                "className", info.getClassName()
            ));
        }

        if (target.isAttribute()) {
            MBeanAttributeInfo attributeInfo = requireAttributeInfo(server, objectName, target.attribute);
            Object value = server.getAttribute(objectName, target.attribute);
            return attributeSnapshot(objectName, attributeInfo, value);
        }

        if (target.isOperation()) {
            MBeanOperationInfo operationInfo = requireOperationInfo(server, objectName, target.operation, target.signature);
            return operationSnapshot(objectName, operationInfo);
        }

        throw new IllegalArgumentException("unsupported target kind: " + target.kind);
    }

    private static Map<String, Object> previewChange(
        MBeanServerConnection server,
        ConnectionSpec connection,
        TargetSpec target,
        Map<String, Object> change
    ) throws Exception {
        requireTarget(target);
        Map<String, Object> payload = optionalObject(change == null ? null : change.get("payload"));

        if (target.isAttribute()) {
            ObjectName objectName = new ObjectName(target.objectName);
            requireDomainAllowed(connection, objectName);
            MBeanAttributeInfo attributeInfo = requireAttributeInfo(server, objectName, target.attribute);
            Map<String, Object> before = attributeSnapshot(objectName, attributeInfo, server.getAttribute(objectName, target.attribute));
            if (!attributeInfo.isWritable()) {
                return preview(false, false,
                    "attribute " + target.attribute + " is not writable",
                    "high",
                    "attribute " + target.attribute + " is not writable",
                    before,
                    null
                );
            }
            if (payload == null || !payload.containsKey("value")) {
                throw new IllegalArgumentException("attribute preview payload.value is required");
            }
            Object next = convertValue(payload.get("value"), attributeInfo.getType());
            return preview(true, false,
                "set " + target.attribute + " on " + objectName.getCanonicalName(),
                "medium",
                null,
                before,
                attributeSnapshot(objectName, attributeInfo, next)
            );
        }

        if (target.isOperation()) {
            ObjectName objectName = new ObjectName(target.objectName);
            requireDomainAllowed(connection, objectName);
            MBeanOperationInfo operationInfo = requireOperationInfo(server, objectName, target.operation, target.signature);
            List<Object> args = argumentList(payload);
            String[] signature = effectiveSignature(target, payload, operationInfo);
            convertArguments(args, signature);

            Map<String, Object> afterValue = new LinkedHashMap<>();
            afterValue.put("plannedArgs", toJsonCompatible(args));
            afterValue.put("signature", Arrays.asList(signature));
            afterValue.put("returnType", operationInfo.getReturnType());
            afterValue.put("description", "preview does not execute the target operation");

            return preview(true, true,
                "invoke " + displayOperationName(operationInfo) + " on " + objectName.getCanonicalName(),
                "high",
                null,
                operationSnapshot(objectName, operationInfo),
                snapshot("operation", "json", afterValue, metadata(
                    "objectName", objectName.getCanonicalName(),
                    "operation", operationInfo.getName(),
                    "signature", Arrays.asList(signature)
                ))
            );
        }

        throw new IllegalArgumentException("preview only supports attribute or operation targets");
    }

    private static Map<String, Object> applyChange(
        MBeanServerConnection server,
        ConnectionSpec connection,
        TargetSpec target,
        Map<String, Object> change
    ) throws Exception {
        requireTarget(target);
        Map<String, Object> payload = optionalObject(change == null ? null : change.get("payload"));

        if (target.isAttribute()) {
            ObjectName objectName = new ObjectName(target.objectName);
            requireDomainAllowed(connection, objectName);
            MBeanAttributeInfo attributeInfo = requireAttributeInfo(server, objectName, target.attribute);
            if (!attributeInfo.isWritable()) {
                throw new IllegalArgumentException("attribute " + target.attribute + " is not writable");
            }
            if (payload == null || !payload.containsKey("value")) {
                throw new IllegalArgumentException("attribute apply payload.value is required");
            }
            Object next = convertValue(payload.get("value"), attributeInfo.getType());
            server.setAttribute(objectName, new Attribute(target.attribute, next));
            return metadata(
                "status", "applied",
                "message", "attribute " + target.attribute + " updated",
                "updatedValue", attributeSnapshot(objectName, attributeInfo, server.getAttribute(objectName, target.attribute))
            );
        }

        if (target.isOperation()) {
            ObjectName objectName = new ObjectName(target.objectName);
            requireDomainAllowed(connection, objectName);
            MBeanOperationInfo operationInfo = requireOperationInfo(server, objectName, target.operation, target.signature);
            List<Object> args = argumentList(payload);
            String[] signature = effectiveSignature(target, payload, operationInfo);
            Object[] convertedArgs = convertArguments(args, signature);
            Object resultValue = server.invoke(objectName, operationInfo.getName(), convertedArgs, signature);

            Map<String, Object> updatedValue = snapshot("operation", "json", metadata(
                "returnValue", toJsonCompatible(resultValue),
                "args", toJsonCompatible(args),
                "signature", Arrays.asList(signature)
            ), metadata(
                "objectName", objectName.getCanonicalName(),
                "operation", operationInfo.getName(),
                "signature", Arrays.asList(signature)
            ));
            return metadata(
                "status", "applied",
                "message", "operation " + displayOperationName(operationInfo) + " invoked",
                "updatedValue", updatedValue
            );
        }

        throw new IllegalArgumentException("apply only supports attribute or operation targets");
    }

    private static MBeanAttributeInfo requireAttributeInfo(
        MBeanServerConnection server,
        ObjectName objectName,
        String attribute
    ) throws Exception {
        MBeanInfo info = server.getMBeanInfo(objectName);
        for (MBeanAttributeInfo item : info.getAttributes()) {
            if (item.getName().equals(attribute)) {
                return item;
            }
        }
        throw new AttributeNotFoundException("attribute " + attribute + " not found on " + objectName.getCanonicalName());
    }

    private static MBeanOperationInfo requireOperationInfo(
        MBeanServerConnection server,
        ObjectName objectName,
        String operation,
        List<String> signature
    ) throws Exception {
        MBeanInfo info = server.getMBeanInfo(objectName);
        List<MBeanOperationInfo> matches = new ArrayList<>();
        for (MBeanOperationInfo item : info.getOperations()) {
            if (item.getName().equals(operation)) {
                matches.add(item);
            }
        }
        if (matches.isEmpty()) {
            throw new IllegalArgumentException("operation " + operation + " not found on " + objectName.getCanonicalName());
        }
        if (signature != null && !signature.isEmpty()) {
            for (MBeanOperationInfo item : matches) {
                if (signatureOf(item).equals(signature)) {
                    return item;
                }
            }
            throw new IllegalArgumentException(
                "operation " + operation + " with signature " + String.join(",", signature) +
                " not found on " + objectName.getCanonicalName()
            );
        }
        if (matches.size() > 1) {
            throw new IllegalArgumentException("operation " + operation + " is overloaded, signature is required");
        }
        return matches.get(0);
    }

    private static String domainOf(ObjectName objectName) {
        return objectName.getDomain();
    }

    static void requireDomainAllowed(ConnectionSpec connection, String domain) {
        if (connection == null) {
            return;
        }
        String rawDomain = domain == null ? "" : domain;
        String normalizedDomain = rawDomain.trim();
        if (normalizedDomain.isEmpty()) {
            if (connection.hasDomainAllowlist()) {
                throw new IllegalArgumentException("domain is not allowed: <default>");
            }
            return;
        }
        if (!rawDomain.equals(normalizedDomain) || !connection.isDomainAllowed(rawDomain)) {
            throw new IllegalArgumentException("domain is not allowed: " + normalizedDomain);
        }
    }

    static void requireDomainAllowed(ConnectionSpec connection, ObjectName objectName) {
        if (objectName == null) {
            return;
        }
        requireDomainAllowed(connection, objectName.getDomain());
    }

    private static void requireTarget(TargetSpec target) {
        if (target == null || target.isRoot()) {
            throw new IllegalArgumentException("change target is required");
        }
    }
}
