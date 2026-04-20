terraform {
  required_version = ">= 1.5"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

variable "do_token" {
  description = "DigitalOcean API token. Generate at https://cloud.digitalocean.com/account/api/tokens."
  type        = string
  sensitive   = true
}

variable "region" {
  description = "DO region slug. See https://docs.digitalocean.com/products/platform/availability-matrix/."
  type        = string
  default     = "nyc3"
}

variable "droplet_size" {
  description = "Droplet size slug. s-1vcpu-1gb is ~$4/mo."
  type        = string
  default     = "s-1vcpu-1gb"
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
  description = "npm semver range for @voidly/pay-hydra. Pinning prevents an upstream breaking release from propagating fleet-wide on the next Restart=always tick."
  type        = string
  default     = "^1.0.0"
}

variable "voidly_api" {
  description = "Pay API base. Override for staging."
  type        = string
  default     = "https://api.voidly.ai"
}

variable "ssh_key_fingerprints" {
  description = "Optional list of SSH key fingerprints on your DO account to preinstall. Strongly recommended — without this you cannot recover the DID key file at /opt/voidly-hydra/keys/active.json if the droplet ever misbehaves."
  type        = list(string)
  default     = []
}

variable "operator_ip_cidrs" {
  description = "CIDRs allowed to SSH into the droplet. Default closes :22 entirely (node still works — agent-card + provider loop don't need inbound SSH). To keep a backdoor for yourself, set to [\"your.ip.address/32\"]. To preserve the previous 0.0.0.0/0 behavior, pass [\"0.0.0.0/0\", \"::/0\"]."
  type        = list(string)
  default     = []
}

variable "key_backup_path" {
  description = "Optional local path to write a backup of the node's DID key (fetched over SSH after first boot). Leave null to skip. Writing this requires ssh_key_fingerprints to be set — otherwise there's no SSH access to the VM. Mode 0600."
  type        = string
  default     = null
}

variable "ssh_private_key_path" {
  description = "Path to the private key matching one of the ssh_key_fingerprints entries. Only used when key_backup_path is set."
  type        = string
  default     = "~/.ssh/id_ed25519"
}

provider "digitalocean" {
  token = var.do_token
}

resource "digitalocean_droplet" "hydra" {
  image    = "ubuntu-24-04-x64"
  name     = "voidly-pay-hydra"
  region   = var.region
  size     = var.droplet_size
  ssh_keys = var.ssh_key_fingerprints
  tags     = ["voidly-pay", "hydra", "provider"]

  user_data = templatefile("${path.module}/../cloud-init.yaml", {
    hydra_capability    = var.hydra_capability
    hydra_price_credits = var.hydra_price_credits
    hydra_sla_hours     = var.hydra_sla_hours
    hydra_version       = var.hydra_version
    voidly_api          = var.voidly_api
  })

  lifecycle {
    # DO occasionally retires and renames slugs — when that happens a
    # stale apply would otherwise recreate the droplet and wipe
    # /opt/voidly-hydra/keys/active.json (DID + wallet). Operators who
    # *want* to upgrade the image taint this resource explicitly.
    ignore_changes = [image]
  }
}

resource "digitalocean_firewall" "hydra" {
  name        = "voidly-pay-hydra"
  droplet_ids = [digitalocean_droplet.hydra.id]

  # Agent card + provider-loop health probe, open to the internet.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "8420"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # SSH — scoped by default. See var.operator_ip_cidrs.
  dynamic "inbound_rule" {
    for_each = length(var.operator_ip_cidrs) > 0 ? [1] : []
    content {
      protocol         = "tcp"
      port_range       = "22"
      source_addresses = var.operator_ip_cidrs
    }
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "null_resource" "key_backup" {
  count = var.key_backup_path != null ? 1 : 0

  triggers = {
    droplet_id = digitalocean_droplet.hydra.id
  }

  # Waits for cloud-init boot check to succeed, then scps the key
  # file back. Runs on apply. Mode 0600 on the local copy.
  provisioner "local-exec" {
    command = <<-EOT
      set -eu
      ip="${digitalocean_droplet.hydra.ipv4_address}"
      key="${pathexpand(var.ssh_private_key_path)}"
      dest="${pathexpand(var.key_backup_path)}"
      mkdir -p "$(dirname "$dest")"

      # Wait for /opt/voidly-hydra/.boot-ok (up to 5 min)
      for i in $(seq 1 60); do
        if ssh -i "$key" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
               root@"$ip" 'test -f /opt/voidly-hydra/.boot-ok' 2>/dev/null; then
          break
        fi
        sleep 5
      done

      # Copy the key file out
      scp -i "$key" -o StrictHostKeyChecking=accept-new \
          root@"$ip":/opt/voidly-hydra/keys/active.json "$dest"
      chmod 600 "$dest"
      echo "key backed up to $dest"
    EOT
  }
}

output "hydra_ipv4" {
  description = "Public IPv4 of the Hydra node."
  value       = digitalocean_droplet.hydra.ipv4_address
}

output "agent_card_url" {
  description = "Agent card URL — the federation crawler can pick this up."
  value       = "http://${digitalocean_droplet.hydra.ipv4_address}:8420/.well-known/agent-card.json"
}

output "healthz_url" {
  description = "Healthz URL. Poll until it returns 200 to confirm the Hydra service is live (cloud-init boot check also writes /opt/voidly-hydra/.boot-ok on success)."
  value       = "http://${digitalocean_droplet.hydra.ipv4_address}:8420/healthz"
}

output "verify_command" {
  description = "Paste to check the node is alive."
  value       = "curl ${format("http://%s:8420/healthz", digitalocean_droplet.hydra.ipv4_address)}"
}

output "ssh_hint" {
  description = "How to reach the box if you need to rescue the DID key."
  value = length(var.operator_ip_cidrs) == 0 ? (
    "SSH is closed (operator_ip_cidrs = []). Add your IP to redeploy firewall rules if you need access."
  ) : "ssh root@${digitalocean_droplet.hydra.ipv4_address} — remember to back up /opt/voidly-hydra/keys/active.json"
}
