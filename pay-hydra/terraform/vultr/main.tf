terraform {
  required_version = ">= 1.5"
  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.21"
    }
  }
}

variable "vultr_api_key" {
  description = "Vultr API key. Generate at https://my.vultr.com/settings/#settingsapi."
  type        = string
  sensitive   = true
}

variable "region" {
  description = "Vultr region slug. `vultr-cli regions list`. ewr (NJ), lax (LA), fra (Frankfurt), sgp (Singapore) are common."
  type        = string
  default     = "ewr"
}

variable "plan" {
  description = "Vultr plan slug. vc2-1c-1gb is ~$6/mo, 1 GB RAM, 1 vCPU. vhf-1c-1gb is the High-Frequency variant."
  type        = string
  default     = "vc2-1c-1gb"
}

variable "os_id" {
  description = "Vultr OS ID. 1743 = Ubuntu 24.04 LTS. List via the /v2/os endpoint."
  type        = number
  default     = 1743
}

variable "hydra_capability" {
  type    = string
  default = "hash.sha256"
}

variable "hydra_price_credits" {
  type    = number
  default = 0.0005
}

variable "hydra_sla_hours" {
  type    = number
  default = 1
}

variable "hydra_version" {
  type    = string
  default = "^1.0.0"
}

variable "voidly_api" {
  type    = string
  default = "https://api.voidly.ai"
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

variable "ssh_key_ids" {
  description = "List of SSH key IDs already uploaded to your Vultr account. Strongly recommended — without this, Vultr emails a root password to your account email, which is noisy and creates an auth surface you probably don't want."
  type        = list(string)
  default     = []
}

variable "operator_ip_cidrs" {
  description = "CIDRs allowed to SSH in. Default closes :22 entirely."
  type        = list(string)
  default     = []
}

provider "vultr" {
  api_key     = var.vultr_api_key
  rate_limit  = 700
  retry_limit = 3
}

resource "vultr_instance" "hydra" {
  label       = "voidly-pay-hydra"
  hostname    = "voidly-pay-hydra"
  region      = var.region
  plan        = var.plan
  os_id       = var.os_id
  enable_ipv6 = true
  tags        = ["voidly-pay", "hydra", "provider"]
  ssh_key_ids = var.ssh_key_ids

  user_data = base64encode(templatefile("${path.module}/../cloud-init.yaml", {
    hydra_capability        = var.hydra_capability
    hydra_price_credits     = var.hydra_price_credits
    hydra_sla_hours         = var.hydra_sla_hours
    hydra_version           = var.hydra_version
    voidly_api              = var.voidly_api
    extra_capabilities_json = jsonencode(var.extra_capabilities)
  }))

  lifecycle {
    ignore_changes = [os_id]
  }
}

# Vultr firewall. :8420 open, :22 gated on operator_ip_cidrs.
resource "vultr_firewall_group" "hydra" {
  description = "voidly-pay-hydra"
}

resource "vultr_firewall_rule" "agent_card_v4" {
  firewall_group_id = vultr_firewall_group.hydra.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = "8420"
  notes             = "agent card"
}

resource "vultr_firewall_rule" "agent_card_v6" {
  firewall_group_id = vultr_firewall_group.hydra.id
  protocol          = "tcp"
  ip_type           = "v6"
  subnet            = "::"
  subnet_size       = 0
  port              = "8420"
  notes             = "agent card v6"
}

resource "vultr_firewall_rule" "ssh_operator" {
  for_each = length(var.operator_ip_cidrs) > 0 ? toset(var.operator_ip_cidrs) : toset([])

  firewall_group_id = vultr_firewall_group.hydra.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
  port              = "22"
  notes             = "operator ssh ${each.value}"
}

output "hydra_ipv4" {
  value = vultr_instance.hydra.main_ip
}

output "agent_card_url" {
  value = "http://${vultr_instance.hydra.main_ip}:8420/.well-known/agent-card.json"
}

output "healthz_url" {
  value = "http://${vultr_instance.hydra.main_ip}:8420/healthz"
}

output "verify_command" {
  value = "curl http://${vultr_instance.hydra.main_ip}:8420/healthz"
}

output "ssh_hint" {
  value = length(var.operator_ip_cidrs) == 0 ? (
    "SSH is closed (operator_ip_cidrs = []). Use Vultr web console for emergency access."
  ) : "ssh root@${vultr_instance.hydra.main_ip} — remember to back up /opt/voidly-hydra/keys/active.json"
}
