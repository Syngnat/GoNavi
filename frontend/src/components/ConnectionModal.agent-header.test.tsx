import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create } from "react-test-renderer";

/**
 * 智能体类型（ChatGPT / Claude Code）没有数据库品牌图标。标题栏的
 * 徽标按数据库图标渲染，智能体类型下会变成「白底白图」的空方块，
 * 而品牌图标在面板正文里已经有了——标题栏不该再重复展示。
 */

vi.mock("../store", async () => (await import("./connectionModalI18nTestSupport")).mockModule1());
vi.mock("../../wailsjs/go/app/App", async () => (await import("./connectionModalI18nTestSupport")).mockModule2());
vi.mock("../utils/overlayWorkbenchTheme", async () => (await import("./connectionModalI18nTestSupport")).mockModule3());
vi.mock("./DatabaseIcons", async () => (await import("./connectionModalI18nTestSupport")).mockModule4());
vi.mock("@ant-design/icons", async () => (await import("./connectionModalI18nTestSupport")).mockModule5());
vi.mock("antd", async () => (await import("./connectionModalI18nTestSupport")).mockModule6());

import ConnectionModal from "./ConnectionModal";
import { findClickableCard } from "./connectionModalI18nTestSupport";
import { setUpConnectionModalI18nTest } from "./connectionModalI18nTestHooks";

const countTypeBadges = (renderer: ReturnType<typeof create>): number =>
  renderer.root.findAll((node) => node.props?.className === "gn-conn-studio-type-badge").length;

describe("ConnectionModal agent type header", () => {
  beforeEach(setUpConnectionModalI18nTest);

  it("renders no type badge for an agent connection type", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });
    // 选到智能体分类里的 ChatGPT。
    await act(async () => {
      findClickableCard(renderer, "ChatGPT").props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // 智能体类型：标题栏不再渲染徽标（正文里已有品牌图标）。
    expect(countTypeBadges(renderer)).toBe(0);
  });

  it("keeps the type badge for a regular database type", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });
    await act(async () => {
      findClickableCard(renderer, "MySQL").props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // 普通数据库类型仍要显示品牌徽标。
    expect(countTypeBadges(renderer)).toBe(1);
  });
});
