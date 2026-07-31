package com.gonavi.fixture;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;

public final class EndpointTestServer {
    private static final String API_KEY = "secret-token";
    private static final String ROOT_PATH = "/manage/jvm";
    private static final Object LOCK = new Object();

    private static Map<String, Object> stateValue = defaultStateValue();
    private static int stateVersion = 1;

    private EndpointTestServer() {
    }

    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 19010;
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext(ROOT_PATH, EndpointTestServer::handleProbe);
        server.createContext(ROOT_PATH + "/resources", EndpointTestServer::handleResources);
        server.createContext(ROOT_PATH + "/value", EndpointTestServer::handleValue);
        server.createContext(ROOT_PATH + "/preview", EndpointTestServer::handlePreview);
        server.createContext(ROOT_PATH + "/apply", EndpointTestServer::handleApply);
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();

        System.out.println("READY");
        System.out.flush();

        new CountDownLatch(1).await();
    }

    private static void handleProbe(HttpExchange exchange) throws IOException {
        if (!ensureMethod(exchange, "GET", "HEAD") || !ensureApiKey(exchange)) {
            return;
        }
        exchange.sendResponseHeaders(204, -1);
        exchange.close();
    }

    private static void handleResources(HttpExchange exchange) throws IOException {
        if (!ensureMethod(exchange, "GET") || !ensureApiKey(exchange)) {
            return;
        }

        String parentPath = queryParam(exchange, "parentPath");
        List<Map<String, Object>> resources = new ArrayList<>();
        if (parentPath.isEmpty()) {
            resources.add(resource("cache.orders", "", "folder", "Orders", "/cache/orders", true, true, true));
        } else if ("/cache/orders".equals(parentPath)) {
            resources.add(resource("cache.orders.state", "cache.orders", "entry", "State", "/cache/orders/state", true, true, false));
        } else {
            sendStatus(exchange, 404, "unknown parentPath: " + parentPath);
            return;
        }

        sendJson(exchange, 200, resources);
    }

    private static void handleValue(HttpExchange exchange) throws IOException {
        if (!ensureMethod(exchange, "GET") || !ensureApiKey(exchange)) {
            return;
        }

        String resourcePath = queryParam(exchange, "resourcePath");
        if ("/cache/orders".equals(resourcePath)) {
            sendJson(exchange, 200, folderSnapshot());
            return;
        }
        if ("/cache/orders/state".equals(resourcePath)) {
            synchronized (LOCK) {
                sendJson(exchange, 200, entrySnapshot(cloneMap(stateValue), currentVersion()));
            }
            return;
        }

        sendStatus(exchange, 404, "unknown resourcePath: " + resourcePath);
    }

    private static void handlePreview(HttpExchange exchange) throws IOException {
        if (!ensureMethod(exchange, "POST") || !ensureApiKey(exchange)) {
            return;
        }

        Map<String, Object> request = readJsonBody(exchange);
        String resourcePath = requiredString(request.get("resourceId"), "resourceId");
        if (!"/cache/orders/state".equals(resourcePath)) {
            sendStatus(exchange, 400, "preview only supports /cache/orders/state");
            return;
        }

        Map<String, Object> payload = requiredObject(request.get("payload"), "payload");
        synchronized (LOCK) {
            Map<String, Object> beforeValue = cloneMap(stateValue);
            Map<String, Object> afterValue = mergeState(beforeValue, payload);
            Map<String, Object> preview = new LinkedHashMap<>();
            preview.put("allowed", Boolean.TRUE);
            preview.put("summary", "preview orders cache state update");
            preview.put("riskLevel", "medium");
            preview.put("before", entrySnapshot(beforeValue, currentVersion()));
            preview.put("after", entrySnapshot(afterValue, currentVersion() + "-preview"));
            sendJson(exchange, 200, preview);
        }
    }

    private static void handleApply(HttpExchange exchange) throws IOException {
        if (!ensureMethod(exchange, "POST") || !ensureApiKey(exchange)) {
            return;
        }

        Map<String, Object> request = readJsonBody(exchange);
        String resourcePath = requiredString(request.get("resourceId"), "resourceId");
        if (!"/cache/orders/state".equals(resourcePath)) {
            sendStatus(exchange, 400, "apply only supports /cache/orders/state");
            return;
        }

        Map<String, Object> payload = requiredObject(request.get("payload"), "payload");
        String expectedVersion = optionalString(request.get("expectedVersion"));

        synchronized (LOCK) {
            String currentVersion = currentVersion();
            if (!expectedVersion.isEmpty() && !expectedVersion.equals(currentVersion)) {
                sendStatus(exchange, 409, "stale version: expected " + expectedVersion + " but current is " + currentVersion);
                return;
            }

            stateValue = mergeState(stateValue, payload);
            stateVersion += 1;

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("status", "applied");
            result.put("message", "orders cache state updated");
            result.put("updatedValue", entrySnapshot(cloneMap(stateValue), currentVersion()));
            sendJson(exchange, 200, result);
        }
    }

    private static boolean ensureMethod(HttpExchange exchange, String... methods) throws IOException {
        String actual = exchange.getRequestMethod();
        for (String method : methods) {
            if (method.equalsIgnoreCase(actual)) {
                return true;
            }
        }
        exchange.getResponseHeaders().set("Allow", String.join(", ", methods));
        sendStatus(exchange, 405, "unsupported method: " + actual);
        return false;
    }

    private static boolean ensureApiKey(HttpExchange exchange) throws IOException {
        String apiKey = exchange.getRequestHeaders().getFirst("X-API-Key");
        if (API_KEY.equals(apiKey)) {
            return true;
        }
        sendStatus(exchange, 401, "missing or invalid api key");
        return false;
    }

    private static String queryParam(HttpExchange exchange, String key) {
        String rawQuery = exchange.getRequestURI().getRawQuery();
        if (rawQuery == null || rawQuery.isEmpty()) {
            return "";
        }

        String[] pairs = rawQuery.split("&");
        for (String pair : pairs) {
            String[] parts = pair.split("=", 2);
            String name = decode(parts[0]);
            if (!key.equals(name)) {
                continue;
            }
            return parts.length > 1 ? decode(parts[1]) : "";
        }
        return "";
    }

    private static Map<String, Object> readJsonBody(HttpExchange exchange) throws IOException {
        try (InputStream inputStream = exchange.getRequestBody()) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = inputStream.read(chunk)) >= 0) {
                buffer.write(chunk, 0, read);
            }
            String payload = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
            Object parsed = MiniJson.parse(payload);
            if (!(parsed instanceof Map<?, ?>)) {
                throw new IllegalArgumentException("request body must be a JSON object");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> request = (Map<String, Object>) parsed;
            return request;
        }
    }

    private static void sendStatus(HttpExchange exchange, int statusCode, String message) throws IOException {
        byte[] body = message.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        exchange.sendResponseHeaders(statusCode, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
    }

    private static void sendJson(HttpExchange exchange, int statusCode, Object payload) throws IOException {
        byte[] body = MiniJson.stringify(payload).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(statusCode, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
    }

    private static Map<String, Object> folderSnapshot() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("name", "Orders");
        value.put("entryCount", 1);
        value.put("resourcePath", "/cache/orders");

        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("resourceId", "/cache/orders");
        snapshot.put("kind", "folder");
        snapshot.put("format", "json");
        snapshot.put("version", "folder-v1");
        snapshot.put("value", value);
        snapshot.put("description", "orders cache root");
        return snapshot;
    }

    private static Map<String, Object> entrySnapshot(Map<String, Object> value, String version) {
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("resourceId", "/cache/orders/state");
        snapshot.put("kind", "entry");
        snapshot.put("format", "json");
        snapshot.put("version", version);
        snapshot.put("value", value);
        snapshot.put("description", "orders cache state");
        snapshot.put("supportedActions", supportedActions());
        return snapshot;
    }

    private static List<Map<String, Object>> supportedActions() {
        List<Map<String, Object>> actions = new ArrayList<>();
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("action", "put");
        action.put("label", "更新缓存状态");
        action.put("description", "将 payload 字段合并到当前订单缓存状态");
        action.put("payloadFields", Arrays.asList(
            payloadField("status", "string", false, "缓存状态"),
            payloadField("lastUpdated", "string", false, "更新时间"),
            payloadField("size", "number", false, "示例大小")
        ));
        action.put("payloadExample", defaultStateValue());
        actions.add(action);
        return actions;
    }

    private static Map<String, Object> payloadField(String name, String type, boolean required, String description) {
        Map<String, Object> field = new LinkedHashMap<>();
        field.put("name", name);
        field.put("type", type);
        field.put("required", required);
        field.put("description", description);
        return field;
    }

    private static Map<String, Object> resource(
        String id,
        String parentId,
        String kind,
        String name,
        String path,
        boolean canRead,
        boolean canWrite,
        boolean hasChildren
    ) {
        Map<String, Object> resource = new LinkedHashMap<>();
        resource.put("id", id);
        if (!parentId.isEmpty()) {
            resource.put("parentId", parentId);
        }
        resource.put("kind", kind);
        resource.put("name", name);
        resource.put("path", path);
        resource.put("providerMode", "endpoint");
        resource.put("canRead", canRead);
        resource.put("canWrite", canWrite);
        resource.put("hasChildren", hasChildren);
        return resource;
    }

    private static Map<String, Object> defaultStateValue() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("status", "warm");
        value.put("lastUpdated", "initial");
        value.put("size", 7);
        return value;
    }

    private static Map<String, Object> mergeState(Map<String, Object> current, Map<String, Object> payload) {
        Map<String, Object> merged = cloneMap(current);
        for (Map.Entry<String, Object> entry : payload.entrySet()) {
            merged.put(entry.getKey(), entry.getValue());
        }
        return merged;
    }

    private static Map<String, Object> cloneMap(Map<String, Object> source) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : source.entrySet()) {
            result.put(entry.getKey(), entry.getValue());
        }
        return result;
    }

    private static String currentVersion() {
        return "state-v" + stateVersion;
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (UnsupportedEncodingException err) {
            throw new IllegalStateException("UTF-8 is unavailable", err);
        }
    }

    private static Map<String, Object> requiredObject(Object value, String field) {
        if (!(value instanceof Map<?, ?>)) {
            throw new IllegalArgumentException(field + " must be an object");
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) value;
        return result;
    }

    private static String requiredString(Object value, String field) {
        String resolved = optionalString(value);
        if (resolved.isEmpty()) {
            throw new IllegalArgumentException(field + " is required");
        }
        return resolved;
    }

    private static String optionalString(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }
}
