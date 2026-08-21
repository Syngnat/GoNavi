#!/usr/bin/env python3

from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class DownloadMirrorConfigTest(unittest.TestCase):
    def test_dmit_uses_local_caddy_without_replacing_other_hosts(self) -> None:
        snippet = (ROOT / "deploy/download-mirror/dmit-caddy-site.caddy").read_text(encoding="utf-8")
        installer = (ROOT / "deploy/download-mirror/install-edge.sh").read_text(encoding="utf-8")

        self.assertIn("download.syngnat.top", snippet)
        self.assertIn("root * /srv/gonavi-downloads", snippet)
        self.assertIn("file_server", snippet)
        self.assertNotIn("reverse_proxy", snippet)
        self.assertFalse((ROOT / "deploy/download-mirror/dmit-nginx.conf").exists())
        self.assertFalse((ROOT / "deploy/download-mirror/tencent-ip-nginx.conf").exists())
        self.assertFalse((ROOT / "deploy/download-mirror/netcup-origin-download.conf").exists())
        self.assertIn("DMIT must retain its existing Caddy listener", installer)
        self.assertIn("dmit:caddy|bero:nginx", installer)
        self.assertIn("Bero Nginx config must declare server_name", installer)
        self.assertIn("Bero Nginx config must listen on 8443 with TLS", installer)
        self.assertIn("Bero Nginx config must not claim ports 80, 443, or 2053", installer)
        self.assertIn("nginx -t", installer)
        self.assertIn("systemctl is-active --quiet nginx", installer)
        self.assertIn("systemctl enable --now nginx", installer)
        self.assertLess(installer.index("nginx -t"), installer.index("systemctl enable --now nginx"))
        self.assertNotIn("tencent", installer.lower())
        self.assertIn("caddy validate", installer)
        self.assertIn("/usr/local/libexec/gonavi-edge-transaction", installer)
        self.assertIn("NOPASSWD: GONAVI_EDGE_CONTROL", installer)

    def test_bero_uses_public_tls_8443_without_claiming_sing_box_ports(self) -> None:
        config = (ROOT / "deploy/download-mirror/bero-origin-download.conf").read_text(encoding="utf-8")

        self.assertIn("server_name origin-download.syngnat.top", config)
        self.assertIn("listen 8443 ssl;", config)
        self.assertIn("listen [::]:8443 ssl;", config)
        self.assertNotIn("listen 80", config)
        self.assertNotIn("listen 443", config)
        self.assertNotIn("listen 2053", config)
        self.assertIn("ssl_certificate /etc/ssl/cloudflare/origin-download.syngnat.top.pem;", config)
        self.assertIn("ssl_certificate_key /etc/ssl/cloudflare/origin-download.syngnat.top.key;", config)
        self.assertIn("root /srv/gonavi-downloads", config)

    def test_publication_uses_dmit_and_bero_with_observability_only_throughput(self) -> None:
        action = (ROOT / ".github/actions/publish-vps-mirror/action.yml").read_text(encoding="utf-8")
        publication = (ROOT / "tools/publish-edge-release.sh").read_text(encoding="utf-8")
        stable_workflow = (ROOT / ".github/workflows/publish-release.yml").read_text(encoding="utf-8")
        dev_workflow = (ROOT / ".github/workflows/dev-build.yml").read_text(encoding="utf-8")

        self.assertIn("dmit-max-bytes", action)
        self.assertIn("default: '9000000000'", action)
        self.assertIn("bero-ssh-host", action)
        self.assertIn("bero-base-url", action)
        self.assertIn("EDGE_BERO_HOST", action)
        self.assertIn("CDN_BERO_SSH_HOST", stable_workflow)
        self.assertIn("CDN_BERO_SSH_HOST", dev_workflow)
        self.assertIn("CDN_BERO_BASE_URL", stable_workflow)
        self.assertIn("CDN_BERO_BASE_URL", dev_workflow)
        self.assertNotIn("CDN_NETCUP_", stable_workflow)
        self.assertNotIn("CDN_NETCUP_", dev_workflow)
        self.assertNotIn("tencent-ssh-", action)
        self.assertNotIn("tencent-max-bytes", action)
        self.assertNotIn("EDGE_TENCENT_", action)
        self.assertNotIn("CDN_TENCENT_", stable_workflow)
        self.assertNotIn("CDN_TENCENT_", dev_workflow)
        self.assertIn("stage_node \"${node}\"", publication)
        self.assertIn("for node in dmit bero", publication)
        self.assertIn("activate_node \"${node}\"", publication)
        self.assertIn("Bero origin SSH host must be 94.103.173.47", publication)
        self.assertIn("Bero origin SSH port must be 37167", publication)
        self.assertIn("https://origin-download.syngnat.top:8443", publication)
        self.assertNotIn("netcup", publication.lower())
        self.assertNotIn("node_value tencent", publication)
        self.assertNotIn("tencent", publication.lower())
        self.assertIn("PUB_THROUGHPUT_WARN_MBPS", publication)
        self.assertIn("::warning::Edge {node} throughput", publication)
        self.assertNotIn("PUB_MIN_THROUGHPUT_MBPS", publication)
        self.assertIn("--min-free-bytes", publication)
        self.assertNotIn("--min-age-seconds 604800", publication)
        self.assertGreaterEqual(publication.count("--min-age-seconds 0"), 2)
        self.assertLess(
            publication.index('echo "[${node}] applying preflight retention"'),
            publication.index('echo "[${node}] checking free space"'),
        )
        self.assertLess(
            publication.index('echo "[${node}] clearing previous staging"'),
            publication.index('echo "[${node}] applying preflight retention"'),
        )
        self.assertIn("ConnectTimeout=${PUB_SSH_CONNECT_TIMEOUT_SECONDS}", publication)
        self.assertIn("--timeout=\"${PUB_RSYNC_IO_TIMEOUT_SECONDS}\"", publication)
        self.assertIn("PUB_RSYNC_COMMAND_TIMEOUT_SECONDS", publication)
        self.assertNotIn("timeout --foreground", publication)
        self.assertIn('PUB_PREPARE_COMMAND_TIMEOUT_SECONDS="${PUB_PREPARE_COMMAND_TIMEOUT_SECONDS:-600}"', publication)
        self.assertIn('PUB_SSH_QUICK_COMMAND_TIMEOUT_SECONDS="${PUB_SSH_QUICK_COMMAND_TIMEOUT_SECONDS:-60}"', publication)
        self.assertIn('PUB_SSH_TRANSACTION_COMMAND_TIMEOUT_SECONDS="${PUB_SSH_TRANSACTION_COMMAND_TIMEOUT_SECONDS:-300}"', publication)
        self.assertIn('PUB_SSH_RETENTION_COMMAND_TIMEOUT_SECONDS="${PUB_SSH_RETENTION_COMMAND_TIMEOUT_SECONDS:-120}"', publication)
        self.assertIn('PUB_RSYNC_COMMAND_TIMEOUT_SECONDS="${PUB_RSYNC_COMMAND_TIMEOUT_SECONDS:-900}"', publication)
        self.assertIn('PUB_THROUGHPUT_REQUEST_TIMEOUT_SECONDS="${PUB_THROUGHPUT_REQUEST_TIMEOUT_SECONDS:-120}"', publication)
        self.assertIn('run_timed "${PUB_PREPARE_COMMAND_TIMEOUT_SECONDS}"', publication)
        self.assertIn('--max-time "${PUB_THROUGHPUT_REQUEST_TIMEOUT_SECONDS}"', publication)
        self.assertNotIn("KV", action)
        self.assertNotIn("PUB_CLOUDFLARE", action)
        self.assertNotIn("PUB_ROUTING_STATE", action)
        self.assertNotIn("CLOUDFLARE_KV_API_TOKEN", stable_workflow)
        self.assertNotIn("CLOUDFLARE_KV_API_TOKEN", dev_workflow)
        self.assertNotIn("ROUTING_STATE_KV_ID", stable_workflow)
        self.assertNotIn("ROUTING_STATE_KV_ID", dev_workflow)
        self.assertIn('timeout-minutes: 120', stable_workflow)
        self.assertIn('timeout-minutes: 120', dev_workflow)
        self.assertIn('echo "[${node}] uploading payload"', publication)
        self.assertIn('echo "[${node}] verifying immutable Range"', publication)

    def test_publication_does_not_require_remote_routing_control(self) -> None:
        action = (ROOT / ".github/actions/publish-vps-mirror/action.yml").read_text(encoding="utf-8")
        publication = (ROOT / "tools/publish-edge-release.sh").read_text(encoding="utf-8")
        dispatcher = (ROOT / "deploy/download-dispatcher/src/core.ts").read_text(encoding="utf-8")
        stable_workflow = (ROOT / ".github/workflows/publish-release.yml").read_text(encoding="utf-8")
        dev_workflow = (ROOT / ".github/workflows/dev-build.yml").read_text(encoding="utf-8")
        deploy_workflow = (ROOT / ".github/workflows/deploy-download-dispatcher.yml").read_text(encoding="utf-8")

        combined = "\n".join((action, publication, dispatcher, stable_workflow, dev_workflow)).lower()
        self.assertNotIn("r2", combined)
        self.assertNotIn("kv", combined)
        self.assertNotIn("cloudflare.com/client/v4", publication)
        self.assertNotIn("put_kv_control", publication)
        self.assertNotIn("control_file", publication)
        self.assertNotIn("ROUTING_STATE", combined)
        self.assertNotIn("wrangler.production.jsonc", deploy_workflow)
        self.assertNotIn("Apply production bindings", deploy_workflow)
        self.assertIn("--config wrangler.jsonc", deploy_workflow)
        self.assertEqual(stable_workflow.count("group: gonavi-download-publication"), 1)
        self.assertEqual(dev_workflow.count("group: gonavi-download-publication"), 1)

    def test_dispatcher_has_no_remote_routing_state_or_refresh_schedule(self) -> None:
        config = json.loads((ROOT / "deploy/download-dispatcher/wrangler.jsonc").read_text(encoding="utf-8"))
        dispatcher = (ROOT / "deploy/download-dispatcher/src/core.ts").read_text(encoding="utf-8")

        self.assertEqual(
            config["routes"],
            [{"pattern": "download-dispatch.syngnat.top", "custom_domain": True}],
        )
        self.assertNotIn("kv_namespaces", config)
        self.assertNotIn("triggers", config)
        self.assertNotIn("ROUTING_STATE", dispatcher)
        self.assertNotIn("scheduled", dispatcher)


if __name__ == "__main__":
    unittest.main()
