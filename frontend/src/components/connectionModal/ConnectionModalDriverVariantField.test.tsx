/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Form, type FormInstance } from "antd";
import { describe, expect, it, vi } from "vitest";

import { t } from "../../i18n";
import ConnectionModalDriverVariantField, { DRIVER_VARIANT_FIELD } from "./ConnectionModalDriverVariantField";
import {
  buildDriverVariantOptions,
  normalizeDriverVariantValue,
  resolveRuntimeDriverKey,
} from "../../utils/dataSourceRegistry/driverVariant";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }));

const renderField = async (dbType: string, initial?: string) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let form: FormInstance | undefined;
  function Harness() {
    const [instance] = Form.useForm();
    form = instance;
    return (
      <Form form={instance} initialValues={{ [DRIVER_VARIANT_FIELD]: initial }}>
        <ConnectionModalDriverVariantField dbType={dbType} form={instance} />
      </Form>
    );
  }
  await act(async () => root.render(<Harness />));
  return {
    host,
    form: () => form as FormInstance,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
};

describe("driver variant helpers", () => {
  it("offers auto plus every declared variant for TiDB", () => {
    const options = buildDriverVariantOptions("tidb");
    expect(options.map((option) => option.value)).toEqual(["auto", "v5", "v6", "v8"]);
    expect(options.every((option) => option.agentKey === "tidb" && !option.separateAgent)).toBe(true);
  });

  it("normalizes stored values per type", () => {
    expect(normalizeDriverVariantValue("tidb", undefined)).toBe("auto");
    expect(normalizeDriverVariantValue("tidb", "V6")).toBe("v6");
    expect(normalizeDriverVariantValue("tidb", "v99")).toBe("auto");
    expect(normalizeDriverVariantValue("mysql", "v6")).toBeUndefined();
    expect(resolveRuntimeDriverKey("tidb", "v5")).toBe("tidb");
    expect(resolveRuntimeDriverKey("MySQL", "x")).toBe("mysql");
  });
});

describe("ConnectionModalDriverVariantField", () => {
  it("defaults a registry type to its declared variant", async () => {
    const view = await renderField("tidb");
    try {
      expect(view.form().getFieldValue(DRIVER_VARIANT_FIELD)).toBe("auto");
      expect(view.host.textContent).toContain(t("connection_modal.field.driverVariant.label"));
    } finally {
      await view.cleanup();
    }
  });

  it("lists the variant labels and descriptions in the dropdown", async () => {
    const view = await renderField("tidb", "v6");
    try {
      await act(async () => {
        view.host.querySelector(".ant-select-selector")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      const titles = Array.from(document.querySelectorAll(".ant-select-item-option")).map((el) => el.getAttribute("title"));
      expect(titles).toEqual([t("connection_modal.field.driverVariant.auto"), "TiDB 4.x – 5.x", "TiDB 6.x – 7.x", "TiDB 8.x +"]);
      expect(document.body.textContent).toContain(t("datasource.variant.tidb.v6"));
    } finally {
      await view.cleanup();
    }
  });

  it("renders nothing and clears the value for legacy types", async () => {
    const view = await renderField("mysql", "v6");
    try {
      expect(view.form().getFieldValue(DRIVER_VARIANT_FIELD)).toBeUndefined();
      expect(view.host.querySelector(".gn-conn-variant-select")).toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});
