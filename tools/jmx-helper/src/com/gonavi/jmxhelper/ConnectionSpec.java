package com.gonavi.jmxhelper;

import static com.gonavi.jmxhelper.JmxRequestValues.integerValue;
import static com.gonavi.jmxhelper.JmxRequestValues.requiredArray;
import static com.gonavi.jmxhelper.JmxRequestValues.requiredString;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

final class ConnectionSpec {
    final String host;
    final int port;
    final String username;
    final String password;
    final List<String> domainAllowlist;

    private ConnectionSpec(
        String host,
        int port,
        String username,
        String password,
        List<String> domainAllowlist
    ) {
        this.host = host;
        this.port = port;
        this.username = username;
        this.password = password;
        this.domainAllowlist = domainAllowlist;
    }

    static ConnectionSpec from(Map<String, Object> source) {
        String host = requiredString(source.get("host"), "connection.host");
        int port = integerValue(source.get("port"), "connection.port");
        String username = source.get("username") == null ? "" : String.valueOf(source.get("username")).trim();
        String password = source.get("password") == null ? "" : String.valueOf(source.get("password"));
        List<String> allowlist = new ArrayList<>();
        if (source.get("domainAllowlist") instanceof List<?>) {
            for (Object item : requiredArray(source.get("domainAllowlist"), "connection.domainAllowlist")) {
                String domain = String.valueOf(item).trim();
                if (!domain.isEmpty()) {
                    allowlist.add(domain);
                }
            }
        }
        return new ConnectionSpec(host, port, username, password, allowlist);
    }

    boolean hasDomainAllowlist() {
        return !domainAllowlist.isEmpty();
    }

    boolean isDomainAllowed(String domain) {
        return domainAllowlist.isEmpty() || domainAllowlist.contains(domain);
    }

    String describe() {
        return host + ":" + port;
    }
}
