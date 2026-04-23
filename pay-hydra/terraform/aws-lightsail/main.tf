terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "region" {
  description = "AWS region for the Lightsail instance."
  type        = string
  default     = "us-east-1"
}

variable "availability_zone" {
  description = "AZ within the region."
  type        = string
  default     = "us-east-1a"
}

variable "bundle_id" {
  description = "Lightsail bundle. nano_3_0 is ~$3.50/mo (Linux)."
  type        = string
  default     = "nano_3_0"
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

variable "extra_capabilities" {
  description = "Additional capabilities to publish on first boot, beyond var.hydra_capability. Each is {slug, price_credits, sla_hours}. Published after primary capability + healthz passes. `voidly-hydra publish` upserts so reapplying is safe."
  type = list(object({
    slug          = string
    price_credits = number
    sla_hours     = optional(number, 1)
  }))
  default = []
}

variable "key_pair_name" {
  description = "Optional Lightsail key pair name to install. Without this, Lightsail auto-generates a key you need to download from the AWS console — fine for one-off nodes, awkward for fleets."
  type        = string
  default     = null
}

variable "operator_ip_cidrs" {
  description = "CIDRs allowed to SSH into the instance. Default closes :22 entirely — the agent-card + provider loop don't need inbound SSH. Set to [\"your.ip/32\"] to keep a backdoor. Pass [\"0.0.0.0/0\"] to preserve the previous behavior."
  type        = list(string)
  default     = []
}

variable "key_backup_path" {
  description = "Optional local path to write a backup of the node's DID key (fetched over SSH after first boot). Requires key_pair_name + operator_ip_cidrs + ssh_private_key_path. Mode 0600."
  type        = string
  default     = null
}

variable "ssh_private_key_path" {
  description = "Path to the private key matching key_pair_name. Only used when key_backup_path is set."
  type        = string
  default     = "~/.ssh/id_ed25519"
}

provider "aws" {
  region = var.region
}

resource "aws_lightsail_instance" "hydra" {
  name              = "voidly-pay-hydra"
  availability_zone = var.availability_zone
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = var.bundle_id
  key_pair_name     = var.key_pair_name

  user_data = templatefile("${path.module}/../cloud-init.yaml", {
    hydra_capability        = var.hydra_capability
    hydra_price_credits     = var.hydra_price_credits
    hydra_sla_hours         = var.hydra_sla_hours
    hydra_version           = var.hydra_version
    voidly_api              = var.voidly_api
    extra_capabilities_json = jsonencode(var.extra_capabilities)
  })

  tags = {
    Name    = "voidly-pay-hydra"
    Project = "voidly-pay"
    Role    = "hydra-provider"
  }

  lifecycle {
    # AWS occasionally retires blueprint IDs; ignore so a refresh
    # doesn't recreate and wipe /opt/voidly-hydra/keys/active.json.
    ignore_changes = [blueprint_id]
  }
}

# Open only the agent-card port by default. SSH is gated on
# operator_ip_cidrs so the AWS console "Connect using SSH" button
# still works (browser SSH from AWS's IP range), but random scanners
# hit a closed port.
resource "aws_lightsail_instance_public_ports" "hydra" {
  instance_name = aws_lightsail_instance.hydra.name

  port_info {
    protocol  = "tcp"
    from_port = 8420
    to_port   = 8420
  }

  dynamic "port_info" {
    for_each = length(var.operator_ip_cidrs) > 0 ? [1] : []
    content {
      protocol  = "tcp"
      from_port = 22
      to_port   = 22
      cidrs     = var.operator_ip_cidrs
    }
  }
}

resource "null_resource" "key_backup" {
  count = var.key_backup_path != null ? 1 : 0

  triggers = {
    instance_name = aws_lightsail_instance.hydra.name
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -eu
      ip="${aws_lightsail_instance.hydra.public_ip_address}"
      key="${pathexpand(var.ssh_private_key_path)}"
      dest="${pathexpand(var.key_backup_path)}"
      mkdir -p "$(dirname "$dest")"

      for i in $(seq 1 60); do
        if ssh -i "$key" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
               ubuntu@"$ip" 'test -f /opt/voidly-hydra/.boot-ok' 2>/dev/null; then
          break
        fi
        sleep 5
      done

      scp -i "$key" -o StrictHostKeyChecking=accept-new \
          ubuntu@"$ip":/opt/voidly-hydra/keys/active.json "$dest"
      chmod 600 "$dest"
      echo "key backed up to $dest"
    EOT
  }
}

output "hydra_ipv4" {
  description = "Public IPv4 of the Hydra node."
  value       = aws_lightsail_instance.hydra.public_ip_address
}

output "agent_card_url" {
  description = "Agent card URL — federation crawler can pick this up."
  value       = "http://${aws_lightsail_instance.hydra.public_ip_address}:8420/.well-known/agent-card.json"
}

output "healthz_url" {
  description = "Healthz URL — poll until 200 to confirm Hydra is live."
  value       = "http://${aws_lightsail_instance.hydra.public_ip_address}:8420/healthz"
}

output "verify_command" {
  description = "Paste to check the node is alive."
  value       = "curl http://${aws_lightsail_instance.hydra.public_ip_address}:8420/healthz"
}

output "ssh_hint" {
  description = "How to reach the box."
  value = length(var.operator_ip_cidrs) == 0 ? (
    "SSH closed (operator_ip_cidrs = []). Use AWS console browser-SSH, or add your IP + re-apply."
  ) : "ssh ubuntu@${aws_lightsail_instance.hydra.public_ip_address} — back up /opt/voidly-hydra/keys/active.json"
}
