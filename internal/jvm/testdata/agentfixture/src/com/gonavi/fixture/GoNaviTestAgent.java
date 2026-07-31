package com.gonavi.fixture;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.lang.instrument.Instrumentation;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

public final class GoNaviTestAgent {
    private static final String ROOT_PATH = "/gonavi/agent/jvm";
    private static final Object LOCK = new Object();

    private static volatile HttpServer server;
    private static volatile String apiKey = "secret-token";
    private static Map<String, Object> stateValue = defaultStateValue();
    private static int stateVersion = 1;

    private GoNaviTestAgent() {
    }

    public static void premain(String args, Instrumentation inst) throws Exception {
        start(args);
    }

    public static void agentmain(String args, Instrumentation inst) throws Exception {
        start(args);
    }

    private static void start(String args) throws Exception {
        synchronized (LOCK) {
            if (server != null) {
                return;
            }

            AgentArgs parsedArgs = parseArgs(args);
            apiKey = parsedArgs.apiKey;

            HttpServer nextServer = HttpServer.create(new InetSocketAddress("127.0.0.1", parsedArgs.port), 0);
            nextServer.createContext(ROOT_PATH, GoNaviTestAgent::handleProbe);
            nextServer.createContext(ROOT_PATH + "/resources", GoNaviTestAgent::handleResources);
            nextServer.createContext(ROOT_PATH + "/value", GoNaviTestAgent::handleValue);
            nextServer.createContext(ROOT_PATH + "/preview", GoNaviTestAgent::handlePreview);
            nextServer.createContext(ROOT_PATH + "/apply", GoNaviTestAgent::handleApply);
            nextServer.setExecutor(Executors.newCachedThreadPool());
            nextServer.start();
            server = nextServer;
        }

        System.out.println("AGENT_READY");
        System.out.flush();
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
            resources.add(resource("agent.cache", "", "folder", "Agent Cache", "/runtime/cache", true, true, true));
        } else if ("/runtime/cache".equals(parentPath)) {
            resources.add(resource("agent.cache.user1001", "agent.cache", "entry", "user:1001", "/runtime/cache/user:1001", true, true, false));
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
        if ("/runtime/cache".equals(resourcePath)) {
            sendJson(exchange, 200, folderSnapshot());
            return;
        }
        if ("/runtime/cache/user:1001".equals(resourcePath)) {
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
        if (!"/runtime/cache/user:1001".equals(resourcePath)) {
            sendStatus(exchange, 400, "preview only supports /runtime/cache/user:1001");
            return;
        }

        Map<String, Object> payload = requiredObject(request.get("payload"), "payload");
        synchronized (LOCK) {
            Map<String, Object> beforeValue = cloneMap(stateValue);
            Map<String, Object> afterValue = mergeState(beforeValue, payload);
            Map<String, Object> preview = new LinkedHashMap<>();
            preview.put("allowed", Boolean.TRUE);
            preview.put("summary", "preview agent cache update");
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
        if (!"/runtime/cache/user:1001".equals(resourcePath)) {
            sendStatus(exchange, 400, "apply only supports /runtime/cache/user:1001");
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
            result.put("message", "agent cache updated");
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
        String requestApiKey = exchange.getRequestHeaders().getFirst("X-API-Key");
        if (apiKey.equals(requestApiKey)) {
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
        value.put("name", "Agent Cache");
        value.put("entryCount", 1);
        value.put("resourcePath", "/runtime/cache");

        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("resourceId", "/runtime/cache");
        snapshot.put("kind", "folder");
        snapshot.put("format", "json");
        snapshot.put("version", "agent-folder-v1");
        snapshot.put("value", value);
        snapshot.put("description", "agent cache root");
        return snapshot;
    }

    private static Map<String, Object> entrySnapshot(Map<String, Object> value, String version) {
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("resourceId", "/runtime/cache/user:1001");
        snapshot.put("kind", "entry");
        snapshot.put("format", "json");
        snapshot.put("version", version);
        snapshot.put("value", value);
        snapshot.put("description", "agent cache entry");
        snapshot.put("supportedActions", supportedActions());
        return snapshot;
    }

    private static List<Map<String, Object>> supportedActions() {
        List<Map<String, Object>> actions = new ArrayList<>();
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("action", "put");
        action.put("label", "Update Cache Entry");
        action.put("description", "Merge payload fields into the current cache entry");
        actions.add(action);
        return actions;
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
        resource.put("parentId", parentId);
        resource.put("kind", kind);
        resource.put("name", name);
        resource.put("path", path);
        resource.put("providerMode", "agent");
        resource.put("canRead", Boolean.valueOf(canRead));
        resource.put("canWrite", Boolean.valueOf(canWrite));
        resource.put("hasChildren", Boolean.valueOf(hasChildren));
        return resource;
    }

    private static Map<String, Object> defaultStateValue() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("status", "cold");
        value.put("score", Integer.valueOf(60));
        value.put("owner", "agent");
        return value;
    }

    private static Map<String, Object> cloneMap(Map<String, Object> input) {
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : input.entrySet()) {
            copy.put(entry.getKey(), entry.getValue());
        }
        return copy;
    }

    private static Map<String, Object> mergeState(Map<String, Object> current, Map<String, Object> payload) {
        Map<String, Object> merged = cloneMap(current);
        for (Map.Entry<String, Object> entry : payload.entrySet()) {
            merged.put(entry.getKey(), entry.getValue());
        }
        return merged;
    }

    private static String currentVersion() {
        return "agent-v" + stateVersion;
    }

    private static String requiredString(Object value, String fieldName) {
        String text = optionalString(value);
        if (text.isEmpty()) {
            throw new IllegalArgumentException(fieldName + " is required");
        }
        return text;
    }

    private static String optionalString(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private static Map<String, Object> requiredObject(Object value, String fieldName) {
        if (!(value instanceof Map<?, ?>)) {
            throw new IllegalArgumentException(fieldName + " must be an object");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> object = (Map<String, Object>) value;
        return object;
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (UnsupportedEncodingException err) {
            throw new IllegalStateException("UTF-8 is unavailable", err);
        }
    }

    private static AgentArgs parseArgs(String rawArgs) {
        AgentArgs args = new AgentArgs();
        args.port = 19090;
        args.apiKey = "secret-token";

        if (rawArgs == null || rawArgs.trim().isEmpty()) {
            return args;
        }

        String[] parts = rawArgs.split(",");
        for (String part : parts) {
            String[] keyValue = part.split("=", 2);
            String key = keyValue[0].trim();
            String value = keyValue.length > 1 ? keyValue[1].trim() : "";
            if ("port".equalsIgnoreCase(key) && !value.isEmpty()) {
                args.port = Integer.parseInt(value);
            } else if ("token".equalsIgnoreCase(key) && !value.isEmpty()) {
                args.apiKey = value;
            }
        }

        return args;
    }

    private static final class AgentArgs {
        private int port;
        private String apiKey;
    }
}
