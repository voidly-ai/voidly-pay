terraform {
  required_version = ">= 1.5"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
  }
}

variable "hcloud_token" {
  description = "Hetzner Cloud API token. Generate under Project → Security → API tokens. Needs Read+Write."
  type        = string
  sensitive   = true
}

variable "location" {
  description = "Hetzner datacenter. One of: nbg1, fsn1, hel1, ash, hil (us), sin."
  type        = string
  default     = "fsn1"
}

variable "server_type" {
  description = "Hetzner VM type. cx22 is ~€4/mo (4GB, 2 vCPU). cpx11 is an Intel alternative."
  type        = string
  default     = "cx22"
}

variable "image" {
  description = "OS image slug. ubuntu-24.04 matches the cloud-init assumptions (Debian-family NodeSource apt)."
  type        = string
  default     = "ubuntu-24.04"
}

variable "hydra_capability" {
  description = "Capability slug to publish. One of: echo.lite, text.reverse, text.uppercase, text.length, hash.sha256."
  type        = string
  default     = "hash.sha256"
}

variable "hydra_price_credits" {
  description = "Credits per call (e.g. 0.0005)."
  type        = number
  default     = 0.0005
}

variable "hydra_sla_hours" {
  description = "Delivery SLA window per hire (hours)."
  type        = number
  default     = 1
}

variable "hydra_version" {
  description = "npm semver range for @voidly/pay-hydra. Pinning prevents an upstream breaking release from propagating fleet-wide."
  type        = string
  default     = "^1.0.0"
}

variable "voidly_api" {
  description = "Pay API base. Override for staging."
  type        = string
  default     = "https://api.voidly.ai"
}

variable "extra_capabilities" {
  description = "Additional capabilities to publish on first boot, beyond var.hydra_capability. Each is {slug, price_credits, sla_hours}. Published after primary capability + healthz passes. `voidly-hydra publish` upserts so reapplying is safe."
  type = list(object({
    slug          = string
    price_credits = number
    sla_hours     = optional(number, 1)
  }))
  default = []
}

variable "ssh_key_names" {
  description = "Optional list of SSH key names already uploaded to the Hetzner Cloud project. Strongly recommended — without this you cannot recover the DID key file at /opt/voidly-hydra/keys/active.json if the server ever misbehaves."
  type        = list(string)
  default     = []
}

variable "operator_ip_cidrs" {
  description = "CIDRs allowed to SSH into the server. Default closes :22 entirely (Hydra still works — the agent-card + provider loop don't need inbound SSH). Set to [\"1.2.3.4/32\"] to keep a backdoor. Pass [\"0.0.0.0/0\", \"::/0\"] for the old open default."
  type        = list(string)
  default     = []
}

variable "key_backup_path" {
  description = "Optional local path to write a backup of the node's DID key (fetched over SSH after first boot). Leave null to skip. Requires ssh_key_names + operator_ip_cidrs. Mode 0600."
  type        = string
  default     = null
}

variable "ssh_private_key_path" {
  description = "Path to the private key matching one of the ssh_key_names entries. Only used when key_backup_path is set."
  type        = string
  default     = "~/.ssh/id_ed25519"
}

provider "hcloud" {
  token = var.hcloud_token
}

# Lookup the SSH key IDs from their names (so operators configure by name).
data "hcloud_ssh_key" "operator_keys" {
  for_each = toset(var.ssh_key_names)
  name     = each.value
}

resource "hcloud_server" "hydra" {
  name        = "voidly-pay-hydra"
  image       = var.image
  server_type = var.server_type
  location    = var.location
  ssh_keys    = [for k in data.hcloud_ssh_key.operator_keys : k.id]

  user_data = templatefile("${path.module}/../cloud-init.yaml", {
    hydra_capability        = var.hydra_capability
    hydra_price_credits     = var.hydra_price_credits
    hydra_sla_hours         = var.hydra_sla_hours
    hydra_version           = var.hydra_version
    voidly_api              = var.voidly_api
    extra_capabilities_json = jsonencode(var.extra_capabilities)
  })

  labels = {
    project = "voidly-pay"
    role    = "hydra-provider"
  }

  # Hetzner retires images occasionally — ignore in-place recreates so a
  # stale apply doesn't wipe /opt/voidly-hydra/keys/active.json (DID + wallet).
  lifecycle {
    ignore_changes = [image]
  }
}

# Firewall — :8420 open for the agent card; :22 scoped to operator_ip_cidrs.
resource "hcloud_firewall" "hydra" {
  name = "voidly-pay-hydra"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "8420"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  dynamic "rule" {
    for_each = length(var.operator_ip_cidrs) > 0 ? [1] : []
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = "22"
      source_ips = var.operator_ip_cidrs
    }
  }
}

resource "hcloud_firewall_attachment" "hydra" {
  firewall_id = hcloud_firewall.hydra.id
  server_ids  = [hcloud_server.hydra.id]
}

# Optional: copy the DID key file out after boot. See var.key_backup_path.
resource "null_resource" "key_backup" {
  count = var.key_backup_path != null ? 1 : 0
  triggers = {
    server_id = hcloud_server.hydra.id
  }
  provisioner "local-exec" {
    command = <<-EOT
      set -eu
      ip="${hcloud_server.hydra.ipv4_address}"
      key="${pathexpand(var.ssh_private_key_path)}"
      dest="${pathexpand(var.key_backup_path)}"
      mkdir -p "$(dirname "$dest")"
      for i in $(seq 1 60); do
        if ssh -i "$key" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
               root@"$ip" 'test -f /opt/voidly-hydra/.boot-ok' 2>/dev/null; then
          break
        fi
        sleep 5
      done
      scp -i "$key" -o StrictHostKeyChecking=accept-new \
          root@"$ip":/opt/voidly-hydra/keys/active.json "$dest"
      chmod 600 "$dest"
      echo "key backed up to $dest"
    EOT
  }
}

output "hydra_ipv4" {
  description = "Public IPv4 of the Hydra node."
  value       = hcloud_server.hydra.ipv4_address
}

output "agent_card_url" {
  description = "Agent card URL — the federation crawler can pick this up."
  value       = "http://${hcloud_server.hydra.ipv4_address}:8420/.well-known/agent-card.json"
}

output "healthz_url" {
  description = "Healthz URL. Poll until 200 to confirm the Hydra service is live."
  value       = "http://${hcloud_server.hydra.ipv4_address}:8420/healthz"
}

output "verify_command" {
  description = "Paste to check the node is alive."
  value       = "curl http://${hcloud_server.hydra.ipv4_address}:8420/healthz"
}

output "ssh_hint" {
  description = "How to reach the box if you need to rescue the DID key."
  value = length(var.operator_ip_cidrs) == 0 ? (
    "SSH is closed (operator_ip_cidrs = []). Add your IP to redeploy firewall rules if you need access."
  ) : "ssh root@${hcloud_server.hydra.ipv4_address} — remember to back up /opt/voidly-hydra/keys/active.json"
}
