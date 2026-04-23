terraform {
  required_version = ">= 1.5"
  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.20"
    }
  }
}

variable "linode_token" {
  description = "Linode API token. Generate at https://cloud.linode.com/profile/tokens. Needs Linodes:read_write + Stackscripts:read."
  type        = string
  sensitive   = true
}

variable "region" {
  description = "Linode region slug. See `linode-cli regions list`. us-east, us-west, eu-west, ap-south are common."
  type        = string
  default     = "us-east"
}

variable "instance_type" {
  description = "Linode instance type. g6-nanode-1 is ~$5/mo, 1GB RAM, 1 vCPU."
  type        = string
  default     = "g6-nanode-1"
}

variable "image" {
  description = "Linode image slug. `linode/ubuntu24.04` matches the cloud-init assumptions (Debian-family NodeSource apt)."
  type        = string
  default     = "linode/ubuntu24.04"
}

variable "hydra_capability" {
  description = "Capability slug to publish."
  type        = string
  default     = "hash.sha256"
}

variable "hydra_price_credits" {
  description = "Credits per call."
  type        = number
  default     = 0.0005
}

variable "hydra_sla_hours" {
  description = "Delivery SLA window per hire (hours)."
  type        = number
  default     = 1
}

variable "hydra_version" {
  description = "npm semver range for @voidly/pay-hydra."
  type        = string
  default     = "^1.0.0"
}

variable "voidly_api" {
  description = "Pay API base."
  type        = string
  default     = "https://api.voidly.ai"
}

variable "extra_capabilities" {
  description = "Additional capabilities to publish on first boot."
  type = list(object({
    slug          = string
    price_credits = number
    sla_hours     = optional(number, 1)
  }))
  default = []
}

variable "authorized_keys" {
  description = "List of SSH public keys (raw `ssh-ed25519 AAAA… comment` strings) to preinstall. Strongly recommended — without this you cannot recover /opt/voidly-hydra/keys/active.json if the instance misbehaves."
  type        = list(string)
  default     = []
}

variable "root_password" {
  description = "Required by Linode API even when using SSH keys. Use a long random string. You'll never type this — SSH is key-based."
  type        = string
  sensitive   = true
}

variable "operator_ip_cidrs" {
  description = "CIDRs allowed to SSH into the instance. Default closes :22 entirely. Set to [\"your.ip/32\"] to keep a backdoor."
  type        = list(string)
  default     = []
}

provider "linode" {
  token = var.linode_token
}

resource "linode_instance" "hydra" {
  label            = "voidly-pay-hydra"
  region           = var.region
  type             = var.instance_type
  image            = var.image
  root_pass        = var.root_password
  authorized_keys  = var.authorized_keys
  private_ip       = false
  watchdog_enabled = true

  metadata {
    user_data = base64encode(templatefile("${path.module}/../cloud-init.yaml", {
      hydra_capability        = var.hydra_capability
      hydra_price_credits     = var.hydra_price_credits
      hydra_sla_hours         = var.hydra_sla_hours
      hydra_version           = var.hydra_version
      voidly_api              = var.voidly_api
      extra_capabilities_json = jsonencode(var.extra_capabilities)
    }))
  }

  tags = ["voidly-pay", "hydra", "provider"]

  lifecycle {
    ignore_changes = [image]
  }
}

# Linode cloud firewall. :8420 open to the internet, :22 gated on operator_ip_cidrs.
resource "linode_firewall" "hydra" {
  label = "voidly-pay-hydra"

  inbound {
    label    = "agent-card"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "8420"
    ipv4     = ["0.0.0.0/0"]
    ipv6     = ["::/0"]
  }

  dynamic "inbound" {
    for_each = length(var.operator_ip_cidrs) > 0 ? [1] : []
    content {
      label    = "ssh-operator"
      action   = "ACCEPT"
      protocol = "TCP"
      ports    = "22"
      ipv4     = var.operator_ip_cidrs
    }
  }

  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"

  linodes = [linode_instance.hydra.id]
}

output "hydra_ipv4" {
  description = "Public IPv4."
  value       = linode_instance.hydra.ip_address
}

output "agent_card_url" {
  description = "Agent card URL."
  value       = "http://${linode_instance.hydra.ip_address}:8420/.well-known/agent-card.json"
}

output "healthz_url" {
  description = "Healthz URL. Poll until 200 to confirm Hydra is live."
  value       = "http://${linode_instance.hydra.ip_address}:8420/healthz"
}

output "verify_command" {
  description = "Paste to check the node is alive."
  value       = "curl http://${linode_instance.hydra.ip_address}:8420/healthz"
}

output "ssh_hint" {
  description = "How to reach the box if you need to rescue the DID key."
  value = length(var.operator_ip_cidrs) == 0 ? (
    "SSH is closed (operator_ip_cidrs = []). Use the Linode console's LISH for emergency access, or add your IP + re-apply."
  ) : "ssh root@${linode_instance.hydra.ip_address} — remember to back up /opt/voidly-hydra/keys/active.json"
}
