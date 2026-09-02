#!/usr/bin/env python3

from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class DownloadMirrorConfigTest(unittest.TestCase):
    def test_cst_uses_public_tls_8443_without_claiming_sing_box_ports(self) -> None:
        config = (ROOT / "deploy/download-mirror/cst-download.conf").read_text(encoding="utf-8")

        self.assertIn("server_name download.syngnat.top", config)
        self.assertIn("listen 8443 ssl;", config)
        self.assertIn("listen [::]:8443 ssl;", config)
        self.assertNotIn("listen 80", config)
        self.assertNotIn("listen 443", config)
        self.assertNotIn("listen 2053", config)
        self.assertIn("ssl_certificate /etc/ssl/cloudflare/download.syngnat.top.pem;", config)
        self.assertIn("ssl_certificate_key /etc/ssl/cloudflare/download.syngnat.top.key;", config)
        self.assertIn("root /srv/gonavi-downloads", config)

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

    def test_installer_accepts_only_static_nginx_origins(self) -> None:
        installer = (ROOT / "deploy/download-mirror/install-edge.sh").read_text(encoding="utf-8")

        self.assertIn("cst:nginx|bero:nginx", installer)
        self.assertIn("Cst must use the Nginx static-site configuration", installer)
        self.assertIn("Nginx config must declare server_name", installer)
        self.assertIn("Nginx config must listen on 8443 with TLS", installer)
        self.assertIn("Nginx config must not claim ports 80, 443, or 2053", installer)
        self.assertIn("nginx -t", installer)
        self.assertIn("systemctl is-active --quiet nginx", installer)
        self.assertIn("systemctl enable --now nginx", installer)
        self.assertLess(installer.index("nginx -t"), installer.index("systemctl enable --now nginx"))
        self.assertNotIn("caddy", installer.lower())
        self.assertNotIn("dmit", installer.lower())
        self.assertIn("/usr/local/libexec/gonavi-edge-transaction", installer)
        self.assertIn("NOPASSWD: GONAVI_EDGE_CONTROL", installer)

    def test_publication_uses_cst_and_bero_with_no_cloudflare_control_plane(self) -> None:
        action = (ROOT / ".github/actions/publish-vps-mirror/action.yml").read_text(encoding="utf-8")
        publication = (ROOT / "tools/publish-edge-release.sh").read_text(encoding="utf-8")
        stable_workflow = (ROOT / ".github/workflows/publish-release.yml").read_text(encoding="utf-8")
        dev_workflow = (ROOT / ".github/workflows/dev-build.yml").read_text(encoding="utf-8")

        self.assertIn("cst-ssh-host", action)
        self.assertIn("cst-max-bytes", action)
        self.assertIn("EDGE_CST_HOST", action)
        self.assertIn("CDN_CST_SSH_HOST", stable_workflow)
        self.assertIn("CDN_CST_SSH_HOST", dev_workflow)
        self.assertIn("CDN_BERO_SSH_HOST", stable_workflow)
        self.assertIn("CDN_BERO_SSH_HOST", dev_workflow)
        self.assertIn("CDN_BERO_BASE_URL", stable_workflow)
        self.assertIn("CDN_BERO_BASE_URL", dev_workflow)
        self.assertIn("for node in cst bero", publication)
        self.assertIn("cst SSH target must be 189.24.81.251:19375", publication)
        self.assertIn("Bero origin SSH host must be 94.103.173.47", publication)
        self.assertIn("Bero origin SSH port must be 37167", publication)
        self.assertIn("https://origin-download.syngnat.top:8443", publication)
        self.assertNotIn("dmit", action.lower())
        self.assertNotIn("dmit", publication.lower())
        self.assertNotIn("dmit", stable_workflow.lower())
        self.assertNotIn("dmit", dev_workflow.lower())
        self.assertNotIn("cloudflare", action.lower())
        self.assertNotIn("cloudflare", publication.lower())
        self.assertNotIn("routing_state", publication.lower())
        self.assertNotIn("kv", publication.lower())
        self.assertIn("PUB_THROUGHPUT_WARN_MBPS", publication)
        self.assertIn("::warning::Edge {node} throughput", publication)
        self.assertIn("--min-free-bytes", publication)
        self.assertIn('PUB_PREPARE_COMMAND_TIMEOUT_SECONDS="${PUB_PREPARE_COMMAND_TIMEOUT_SECONDS:-600}"', publication)
        self.assertIn('PUB_SSH_CONTROL_PERSIST_SECONDS="${PUB_SSH_CONTROL_PERSIST_SECONDS:-300}"', publication)
        self.assertIn("ssh_control_path()", publication)
        self.assertIn("ControlMaster=auto", publication)
        self.assertIn('stop_ssh_control_master cst', publication)
        self.assertIn('stop_ssh_control_master bero', publication)
        self.assertNotIn("PUB_KV_REQUEST_TIMEOUT_SECONDS", publication)
        self.assertNotIn("CLOUDFLARE_KV_API_TOKEN", stable_workflow)
        self.assertNotIn("CLOUDFLARE_KV_API_TOKEN", dev_workflow)
        self.assertNotIn("ROUTING_STATE_KV_ID", stable_workflow)
        self.assertNotIn("ROUTING_STATE_KV_ID", dev_workflow)
        self.assertIn('echo "[${node}] uploading payload"', publication)
        self.assertIn('echo "[${node}] verifying immutable Range"', publication)

    def test_dispatcher_deploy_has_no_kv_binding_or_cron(self) -> None:
        config = json.loads((ROOT / "deploy/download-dispatcher/wrangler.jsonc").read_text(encoding="utf-8"))
        dispatcher = (ROOT / "deploy/download-dispatcher/src/core.ts").read_text(encoding="utf-8")
        index = (ROOT / "deploy/download-dispatcher/src/index.ts").read_text(encoding="utf-8")
        deploy_workflow = (ROOT / ".github/workflows/deploy-download-dispatcher.yml").read_text(encoding="utf-8")

        self.assertEqual(config["routes"], [{"pattern": "download-dispatch.syngnat.top", "custom_domain": True}])
        self.assertNotIn("kv_namespaces", config)
        self.assertNotIn("triggers", config)
        self.assertNotIn("ROUTING_STATE", dispatcher)
        self.assertNotIn("scheduled", index)
        self.assertNotIn("wrangler.production.jsonc", deploy_workflow)
        self.assertNotIn("Apply production bindings", deploy_workflow)
        self.assertIn("--config wrangler.jsonc", deploy_workflow)


if __name__ == "__main__":
    unittest.main()
