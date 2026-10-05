package com.gonavi.jmxhelper;

import static com.gonavi.jmxhelper.JmxPayloads.addUnique;
import static com.gonavi.jmxhelper.JmxRuntime.requireDomainAllowed;

import java.lang.management.ClassLoadingMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.management.MBeanServerConnection;
import javax.management.ObjectName;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.TabularData;

final class JmxMonitoringSnapshot {
    private JmxMonitoringSnapshot() {
    }

    static Map<String, Object> getMonitoringSnapshot(MBeanServerConnection server, ConnectionSpec connection) throws Exception {
        requireDomainAllowed(connection, "java.lang");

        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        LinkedHashMap<String, Object> point = new LinkedHashMap<>();
        List<String> availableMetrics = new ArrayList<>();
        List<String> missingMetrics = new ArrayList<>();
        List<String> providerWarnings = new ArrayList<>();

        long sampleTimestamp = System.currentTimeMillis();
        point.put("timestamp", sampleTimestamp);

        try {
            ThreadMXBean threadBean = ManagementFactory.newPlatformMXBeanProxy(
                server,
                ManagementFactory.THREAD_MXBEAN_NAME,
                ThreadMXBean.class
            );
            point.put("threadCount", threadBean.getThreadCount());
            point.put("daemonThreadCount", threadBean.getDaemonThreadCount());
            point.put("peakThreadCount", threadBean.getPeakThreadCount());
            addUnique(availableMetrics, "thread.count");

            long[] threadIds = threadBean.getAllThreadIds();
            ThreadInfo[] infos = threadBean.getThreadInfo(threadIds, 0);
            Map<String, Object> stateCounts = new LinkedHashMap<>();
            for (ThreadInfo info : infos) {
                if (info == null || info.getThreadState() == null) {
                    continue;
                }
                String state = info.getThreadState().name();
                int current = stateCounts.get(state) instanceof Number
                    ? ((Number) stateCounts.get(state)).intValue()
                    : 0;
                stateCounts.put(state, current + 1);
            }
            if (!stateCounts.isEmpty()) {
                point.put("threadStateCounts", stateCounts);
                addUnique(availableMetrics, "thread.states");
            }
        } catch (Exception error) {
            addUnique(missingMetrics, "thread.count");
            addUnique(providerWarnings, "thread metrics unavailable: " + error.getMessage());
        }

        try {
            MemoryMXBean memoryBean = ManagementFactory.newPlatformMXBeanProxy(
                server,
                ManagementFactory.MEMORY_MXBEAN_NAME,
                MemoryMXBean.class
            );
            MemoryUsage heap = memoryBean.getHeapMemoryUsage();
            if (heap != null) {
                point.put("heapUsedBytes", heap.getUsed());
                point.put("heapCommittedBytes", heap.getCommitted());
                point.put("heapMaxBytes", heap.getMax());
                addUnique(availableMetrics, "heap.used");
            } else {
                addUnique(missingMetrics, "heap.used");
            }

            MemoryUsage nonHeap = memoryBean.getNonHeapMemoryUsage();
            if (nonHeap != null) {
                point.put("nonHeapUsedBytes", nonHeap.getUsed());
                point.put("nonHeapCommittedBytes", nonHeap.getCommitted());
                addUnique(availableMetrics, "heap.non_heap");
            }
        } catch (Exception error) {
            addUnique(missingMetrics, "heap.used");
            addUnique(providerWarnings, "heap metrics unavailable: " + error.getMessage());
        }

        try {
            ClassLoadingMXBean classLoadingBean = ManagementFactory.newPlatformMXBeanProxy(
                server,
                ManagementFactory.CLASS_LOADING_MXBEAN_NAME,
                ClassLoadingMXBean.class
            );
            point.put("loadedClassCount", classLoadingBean.getLoadedClassCount());
            point.put("unloadedClassCount", classLoadingBean.getUnloadedClassCount());
            addUnique(availableMetrics, "class.loading");
        } catch (Exception error) {
            addUnique(missingMetrics, "class.loading");
            addUnique(providerWarnings, "class loading metrics unavailable: " + error.getMessage());
        }

        try {
            List<Map<String, Object>> recentGcEvents = new ArrayList<>();
            long totalCount = 0L;
            long totalTime = 0L;
            Set<ObjectName> names = server.queryNames(
                new ObjectName(ManagementFactory.GARBAGE_COLLECTOR_MXBEAN_DOMAIN_TYPE + ",*"),
                null
            );
            for (ObjectName name : names) {
                Long collectionCount = safeLongAttribute(server, name, "CollectionCount");
                if (collectionCount != null && collectionCount >= 0L) {
                    totalCount += collectionCount.longValue();
                }
                Long collectionTime = safeLongAttribute(server, name, "CollectionTime");
                if (collectionTime != null && collectionTime >= 0L) {
                    totalTime += collectionTime.longValue();
                }

                Object lastGcInfo = safeAttribute(server, name, "LastGcInfo");
                if (lastGcInfo instanceof CompositeData) {
                    CompositeData data = (CompositeData) lastGcInfo;
                    LinkedHashMap<String, Object> event = new LinkedHashMap<>();
                    event.put("timestamp", sampleTimestamp);
                    event.put("name", name.getKeyProperty("name"));
                    Object gcCause = compositeValue(data, "GcCause");
                    if (gcCause != null) {
                        event.put("cause", String.valueOf(gcCause));
                    }
                    Object gcAction = compositeValue(data, "GcAction");
                    if (gcAction != null) {
                        event.put("action", String.valueOf(gcAction));
                    }
                    Object duration = compositeValue(data, "duration");
                    if (duration instanceof Number) {
                        event.put("durationMs", ((Number) duration).longValue());
                    }
                    long beforeUsedBytes = sumMemoryUsage(compositeValue(data, "memoryUsageBeforeGc"));
                    if (beforeUsedBytes > 0L) {
                        event.put("beforeUsedBytes", beforeUsedBytes);
                    }
                    long afterUsedBytes = sumMemoryUsage(compositeValue(data, "memoryUsageAfterGc"));
                    if (afterUsedBytes > 0L) {
                        event.put("afterUsedBytes", afterUsedBytes);
                    }
                    recentGcEvents.add(event);
                }
            }
            point.put("gcCollectionCount", totalCount);
            point.put("gcCollectionTimeMs", totalTime);
            result.put("recentGcEvents", recentGcEvents);
            addUnique(availableMetrics, "gc.count");
            addUnique(availableMetrics, "gc.time");
            if (!recentGcEvents.isEmpty()) {
                addUnique(availableMetrics, "gc.events");
            } else {
                addUnique(missingMetrics, "gc.events");
            }
        } catch (Exception error) {
            addUnique(missingMetrics, "gc.count");
            addUnique(missingMetrics, "gc.time");
            addUnique(missingMetrics, "gc.events");
            addUnique(providerWarnings, "gc metrics unavailable: " + error.getMessage());
        }

        try {
            ObjectName osName = new ObjectName("java.lang:type=OperatingSystem");
            Double processCpuLoad = safeDoubleAttribute(server, osName, "ProcessCpuLoad");
            if (processCpuLoad != null && processCpuLoad >= 0d) {
                point.put("processCpuLoad", processCpuLoad.doubleValue());
                addUnique(availableMetrics, "cpu.process");
            } else {
                addUnique(missingMetrics, "cpu.process");
            }

            Double systemCpuLoad = safeDoubleAttribute(server, osName, "SystemCpuLoad");
            if (systemCpuLoad != null && systemCpuLoad >= 0d) {
                point.put("systemCpuLoad", systemCpuLoad.doubleValue());
                addUnique(availableMetrics, "cpu.system");
            } else {
                addUnique(missingMetrics, "cpu.system");
            }

            Long processRssBytes = firstNumericAttribute(
                server,
                osName,
                "ProcessResidentMemorySize",
                "ResidentSetSize",
                "ResidentMemorySize"
            );
            if (processRssBytes != null && processRssBytes >= 0L) {
                point.put("processRssBytes", processRssBytes.longValue());
                addUnique(availableMetrics, "memory.rss");
            } else {
                addUnique(missingMetrics, "memory.rss");
            }

            Long committedVirtualMemoryBytes = safeLongAttribute(server, osName, "CommittedVirtualMemorySize");
            if (committedVirtualMemoryBytes != null && committedVirtualMemoryBytes >= 0L) {
                point.put("committedVirtualMemoryBytes", committedVirtualMemoryBytes.longValue());
                addUnique(availableMetrics, "memory.virtual");
            } else {
                addUnique(missingMetrics, "memory.virtual");
            }
        } catch (Exception error) {
            addUnique(missingMetrics, "cpu.process");
            addUnique(missingMetrics, "cpu.system");
            addUnique(missingMetrics, "memory.rss");
            addUnique(missingMetrics, "memory.virtual");
            addUnique(providerWarnings, "process/system metrics unavailable: " + error.getMessage());
        }

        result.put("point", point);
        result.put("availableMetrics", availableMetrics);
        result.put("missingMetrics", missingMetrics);
        result.put("providerWarnings", providerWarnings);
        return result;
    }

    static Object safeAttribute(MBeanServerConnection server, ObjectName objectName, String attribute) {
        try {
            return server.getAttribute(objectName, attribute);
        } catch (Exception error) {
            return null;
        }
    }

    static Long safeLongAttribute(MBeanServerConnection server, ObjectName objectName, String attribute) {
        Object value = safeAttribute(server, objectName, attribute);
        return value instanceof Number ? ((Number) value).longValue() : null;
    }

    static Double safeDoubleAttribute(MBeanServerConnection server, ObjectName objectName, String attribute) {
        Object value = safeAttribute(server, objectName, attribute);
        return value instanceof Number ? ((Number) value).doubleValue() : null;
    }

    static Long firstNumericAttribute(
        MBeanServerConnection server,
        ObjectName objectName,
        String... attributeNames
    ) {
        for (String attributeName : attributeNames) {
            Long value = safeLongAttribute(server, objectName, attributeName);
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    static Object compositeValue(CompositeData data, String key) {
        if (data == null || key == null || !data.getCompositeType().containsKey(key)) {
            return null;
        }
        return data.get(key);
    }

    static long sumMemoryUsage(Object value) {
        long total = 0L;
        if (value instanceof TabularData) {
            for (Object item : ((TabularData) value).values()) {
                total += usedFromMemoryUsage(item);
            }
            return total;
        }
        if (value instanceof Map<?, ?>) {
            for (Object item : ((Map<?, ?>) value).values()) {
                total += usedFromMemoryUsage(item);
            }
            return total;
        }
        return usedFromMemoryUsage(value);
    }

    static long usedFromMemoryUsage(Object value) {
        if (!(value instanceof CompositeData)) {
            return 0L;
        }
        CompositeData data = (CompositeData) value;
        Object used = compositeValue(data, "used");
        if (used instanceof Number) {
            return ((Number) used).longValue();
        }
        Object nestedValue = compositeValue(data, "value");
        return usedFromMemoryUsage(nestedValue);
    }
}
