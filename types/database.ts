export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          metadata: NonNullable<Json>
          property_id: string | null
          request_id: string | null
          tenant_id: string | null
        }
        ComputedFields: never
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          metadata?: NonNullable<Json>
          property_id?: string | null
          request_id?: string | null
          tenant_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          metadata?: NonNullable<Json>
          property_id?: string | null
          request_id?: string | null
          tenant_id?: string | null
        }
        Relationships: []
      }
      daily_rates: {
        Row: {
          amount_minor: number
          business_date: string
          created_at: string
          currency: string
          id: string
          property_id: string
          rate_plan_id: string
          room_type_id: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          amount_minor: number
          business_date: string
          created_at?: string
          currency?: string
          id?: string
          property_id: string
          rate_plan_id: string
          room_type_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount_minor?: number
          business_date?: string
          created_at?: string
          currency?: string
          id?: string
          property_id?: string
          rate_plan_id?: string
          room_type_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_rates_tenant_id_property_id_rate_plan_id_fkey"
            columns: ["tenant_id", "property_id", "rate_plan_id"]
            isOneToOne: false
            referencedRelation: "rate_plans"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
          {
            foreignKeyName: "daily_rates_tenant_id_property_id_room_type_id_fkey"
            columns: ["tenant_id", "property_id", "room_type_id"]
            isOneToOne: false
            referencedRelation: "room_types"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      discount_cap_overrides: {
        Row: {
          max_percent: number
          property_id: string
          role_key: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          max_percent: number
          property_id: string
          role_key: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          max_percent?: number
          property_id?: string
          role_key?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "discount_cap_overrides_role_key_fkey"
            columns: ["role_key"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "discount_cap_overrides_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      discount_caps: {
        Row: {
          max_percent: number
          role_key: string
        }
        Insert: {
          max_percent: number
          role_key: string
        }
        Update: {
          max_percent?: number
          role_key?: string
        }
        Relationships: []
      }
      email_outbox: {
        Row: {
          attempts: number
          created_at: string
          dedupe_key: string | null
          id: string
          kind: string
          last_error: string | null
          next_attempt_at: string
          payload: NonNullable<Json>
          reservation_id: string
          sent_at: string | null
          status: string
          tenant_id: string
          to_email: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          attempts?: number
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind: string
          last_error?: string | null
          next_attempt_at?: string
          payload?: NonNullable<Json>
          reservation_id: string
          sent_at?: string | null
          status?: string
          tenant_id: string
          to_email: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind?: string
          last_error?: string | null
          next_attempt_at?: string
          payload?: NonNullable<Json>
          reservation_id?: string
          sent_at?: string | null
          status?: string
          tenant_id?: string
          to_email?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_outbox_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_outbox_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      folio_charges: {
        Row: {
          category: string
          charge_date: string
          created_at: string
          currency: string
          description: string
          folio_invoice_id: string | null
          id: string
          posted_by: string | null
          property_id: string
          quantity: number
          reservation_id: string
          reservation_room_id: string | null
          status: string
          tax_minor: number
          tenant_id: string
          total_minor: number
          unit_amount_minor: number
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        ComputedFields: never
        Insert: {
          category: string
          charge_date: string
          created_at?: string
          currency: string
          description: string
          folio_invoice_id?: string | null
          id?: string
          posted_by?: string | null
          property_id: string
          quantity: number
          reservation_id: string
          reservation_room_id?: string | null
          status?: string
          tax_minor?: number
          tenant_id: string
          total_minor: number
          unit_amount_minor: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          category?: string
          charge_date?: string
          created_at?: string
          currency?: string
          description?: string
          folio_invoice_id?: string | null
          id?: string
          posted_by?: string | null
          property_id?: string
          quantity?: number
          reservation_id?: string
          reservation_room_id?: string | null
          status?: string
          tax_minor?: number
          tenant_id?: string
          total_minor?: number
          unit_amount_minor?: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "folio_charges_folio_invoice_id_fkey"
            columns: ["folio_invoice_id"]
            isOneToOne: false
            referencedRelation: "folio_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "folio_charges_reservation_room_id_fkey"
            columns: ["reservation_room_id"]
            isOneToOne: false
            referencedRelation: "reservation_rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "folio_charges_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "folio_charges_tenant_id_property_id_reservation_id_fkey"
            columns: ["tenant_id", "property_id", "reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      folio_invoice_lines: {
        Row: {
          category: string
          created_at: string
          description: string
          folio_charge_id: string
          folio_invoice_id: string
          id: string
          line_total_minor: number
          property_id: string
          quantity: number
          service_date: string
          tax_minor: number
          tenant_id: string
          unit_amount_minor: number
        }
        ComputedFields: never
        Insert: {
          category: string
          created_at?: string
          description: string
          folio_charge_id: string
          folio_invoice_id: string
          id?: string
          line_total_minor: number
          property_id: string
          quantity: number
          service_date: string
          tax_minor: number
          tenant_id: string
          unit_amount_minor: number
        }
        Update: {
          category?: string
          created_at?: string
          description?: string
          folio_charge_id?: string
          folio_invoice_id?: string
          id?: string
          line_total_minor?: number
          property_id?: string
          quantity?: number
          service_date?: string
          tax_minor?: number
          tenant_id?: string
          unit_amount_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "folio_invoice_lines_folio_charge_id_fkey"
            columns: ["folio_charge_id"]
            isOneToOne: false
            referencedRelation: "folio_charges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "folio_invoice_lines_folio_invoice_id_fkey"
            columns: ["folio_invoice_id"]
            isOneToOne: false
            referencedRelation: "folio_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      folio_invoices: {
        Row: {
          created_at: string
          currency: string
          id: string
          invoice_number: string
          invoice_status: string
          issued_at: string
          issued_by: string | null
          property_id: string
          reservation_id: string
          subtotal_minor: number
          tax_minor: number
          tenant_id: string
          total_minor: number
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          currency: string
          id?: string
          invoice_number: string
          invoice_status?: string
          issued_at?: string
          issued_by?: string | null
          property_id: string
          reservation_id: string
          subtotal_minor: number
          tax_minor: number
          tenant_id: string
          total_minor: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          created_at?: string
          currency?: string
          id?: string
          invoice_number?: string
          invoice_status?: string
          issued_at?: string
          issued_by?: string | null
          property_id?: string
          reservation_id?: string
          subtotal_minor?: number
          tax_minor?: number
          tenant_id?: string
          total_minor?: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "folio_invoices_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "folio_invoices_tenant_id_property_id_reservation_id_fkey"
            columns: ["tenant_id", "property_id", "reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      folio_payments: {
        Row: {
          amount_minor: number
          created_at: string
          currency: string
          id: string
          internal_reference: string
          note: string | null
          payment_method: string
          payment_status: string
          property_id: string
          provider_reference: string | null
          received_at: string
          recorded_by: string | null
          reservation_id: string
          reverse_reason: string | null
          reversed_at: string | null
          reversed_by: string | null
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          amount_minor: number
          created_at?: string
          currency: string
          id?: string
          internal_reference: string
          note?: string | null
          payment_method: string
          payment_status?: string
          property_id: string
          provider_reference?: string | null
          received_at?: string
          recorded_by?: string | null
          reservation_id: string
          reverse_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount_minor?: number
          created_at?: string
          currency?: string
          id?: string
          internal_reference?: string
          note?: string | null
          payment_method?: string
          payment_status?: string
          property_id?: string
          provider_reference?: string | null
          received_at?: string
          recorded_by?: string | null
          reservation_id?: string
          reverse_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "folio_payments_tenant_id_property_id_reservation_id_fkey"
            columns: ["tenant_id", "property_id", "reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      guest_change_requests: {
        Row: {
          created_at: string
          id: string
          kind: string
          message: string | null
          property_id: string
          requested_arrival: string | null
          requested_departure: string | null
          reservation_id: string
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          message?: string | null
          property_id: string
          requested_arrival?: string | null
          requested_departure?: string | null
          reservation_id: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          message?: string | null
          property_id?: string
          requested_arrival?: string | null
          requested_departure?: string | null
          reservation_id?: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_change_requests_tenant_id_property_id_reservation_id_fkey"
            columns: ["tenant_id", "property_id", "reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      guests: {
        Row: {
          address: string | null
          country_code: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          phone: string | null
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          address?: string | null
          country_code?: string | null
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          phone?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          country_code?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          phone?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      housekeeping_tasks: {
        Row: {
          assigned_to: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          completed_at: string | null
          completed_by: string | null
          completion_note: string | null
          created_at: string
          created_by: string | null
          due_at: string | null
          id: string
          notes: string | null
          priority: string
          property_id: string
          room_id: string
          started_at: string | null
          status: string
          task_type: string
          tenant_id: string
          updated_at: string
          hk_task_json: Json | null
        }
        ComputedFields: "hk_task_json"
        Insert: {
          assigned_to?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          completed_by?: string | null
          completion_note?: string | null
          created_at?: string
          created_by?: string | null
          due_at?: string | null
          id?: string
          notes?: string | null
          priority?: string
          property_id: string
          room_id: string
          started_at?: string | null
          status?: string
          task_type?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          completed_by?: string | null
          completion_note?: string | null
          created_at?: string
          created_by?: string | null
          due_at?: string | null
          id?: string
          notes?: string | null
          priority?: string
          property_id?: string
          room_id?: string
          started_at?: string | null
          status?: string
          task_type?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "housekeeping_tasks_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "housekeeping_tasks_tenant_id_property_id_room_id_fkey"
            columns: ["tenant_id", "property_id", "room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          idempotency_key: string
          operation: string
          request_hash: string
          response: Json | null
          tenant_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          idempotency_key: string
          operation: string
          request_hash: string
          response?: Json | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          idempotency_key?: string
          operation?: string
          request_hash?: string
          response?: Json | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_lines: {
        Row: {
          description: string
          id: string
          invoice_id: string
          line_total_minor: number
          quantity: number
          service_date: string | null
          tax_amount_minor: number
          tenant_id: string
          unit_amount_minor: number
        }
        ComputedFields: never
        Insert: {
          description: string
          id?: string
          invoice_id: string
          line_total_minor: number
          quantity?: number
          service_date?: string | null
          tax_amount_minor?: number
          tenant_id: string
          unit_amount_minor: number
        }
        Update: {
          description?: string
          id?: string
          invoice_id?: string
          line_total_minor?: number
          quantity?: number
          service_date?: string | null
          tax_amount_minor?: number
          tenant_id?: string
          unit_amount_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_lines_tenant_id_invoice_id_fkey"
            columns: ["tenant_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      invoice_sequences: {
        Row: {
          last_number: number
          property_id: string
          year: number
        }
        ComputedFields: never
        Insert: {
          last_number?: number
          property_id: string
          year: number
        }
        Update: {
          last_number?: number
          property_id?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_sequences_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          created_at: string
          created_by: string | null
          currency: string
          discount_minor: number
          due_at: string | null
          id: string
          invoice_number: string
          invoice_status: string
          issued_at: string
          property_id: string
          reservation_id: string
          subtotal_minor: number
          tax_minor: number
          tenant_id: string
          total_minor: number
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          created_by?: string | null
          currency: string
          discount_minor?: number
          due_at?: string | null
          id?: string
          invoice_number: string
          invoice_status?: string
          issued_at?: string
          property_id: string
          reservation_id: string
          subtotal_minor: number
          tax_minor: number
          tenant_id: string
          total_minor: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          currency?: string
          discount_minor?: number
          due_at?: string | null
          id?: string
          invoice_number?: string
          invoice_status?: string
          issued_at?: string
          property_id?: string
          reservation_id?: string
          subtotal_minor?: number
          tax_minor?: number
          tenant_id?: string
          total_minor?: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_property_id_reservation_id_fkey"
            columns: ["tenant_id", "property_id", "reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      maintenance_requests: {
        Row: {
          assigned_to: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          created_at: string
          description: string | null
          due_at: string | null
          id: string
          location: string | null
          priority: string
          property_id: string
          reported_by: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          room_block_id: string | null
          room_id: string | null
          started_at: string | null
          status: string
          tenant_id: string
          title: string
          updated_at: string
          mt_request_json: Json | null
        }
        ComputedFields: "mt_request_json"
        Insert: {
          assigned_to?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          id?: string
          location?: string | null
          priority?: string
          property_id: string
          reported_by?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          room_block_id?: string | null
          room_id?: string | null
          started_at?: string | null
          status?: string
          tenant_id: string
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          id?: string
          location?: string | null
          priority?: string
          property_id?: string
          reported_by?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          room_block_id?: string | null
          room_id?: string | null
          started_at?: string | null
          status?: string
          tenant_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_requests_room_block_id_fkey"
            columns: ["room_block_id"]
            isOneToOne: false
            referencedRelation: "room_board_claims_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_requests_room_block_id_fkey"
            columns: ["room_block_id"]
            isOneToOne: false
            referencedRelation: "room_inventory_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_requests_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "maintenance_requests_tenant_id_property_id_room_id_fkey"
            columns: ["tenant_id", "property_id", "room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      membership_roles: {
        Row: {
          created_at: string
          id: string
          membership_id: string
          property_id: string | null
          role_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          membership_id: string
          property_id?: string | null
          role_id: string
        }
        Update: {
          created_at?: string
          id?: string
          membership_id?: string
          property_id?: string | null
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_roles_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "tenant_memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_roles_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_roles_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_allocations: {
        Row: {
          amount_minor: number
          created_at: string
          id: string
          invoice_id: string
          payment_id: string
          tenant_id: string
        }
        ComputedFields: never
        Insert: {
          amount_minor: number
          created_at?: string
          id?: string
          invoice_id: string
          payment_id: string
          tenant_id: string
        }
        Update: {
          amount_minor?: number
          created_at?: string
          id?: string
          invoice_id?: string
          payment_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_allocations_tenant_id_invoice_id_fkey"
            columns: ["tenant_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "payment_allocations_tenant_id_payment_id_fkey"
            columns: ["tenant_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      payment_attempts: {
        Row: {
          amount_minor: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          currency: string
          failure_reason: string | null
          id: string
          property_id: string
          provider: string
          reference: string
          reservation_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          amount_minor: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          currency: string
          failure_reason?: string | null
          id?: string
          property_id: string
          provider: string
          reference: string
          reservation_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount_minor?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          failure_reason?: string | null
          id?: string
          property_id?: string
          provider?: string
          reference?: string
          reservation_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_attempts_tenant_id_property_id_reservation_id_fkey"
            columns: ["tenant_id", "property_id", "reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      payment_events: {
        Row: {
          error_summary: string | null
          event_type: string | null
          id: string
          payload: NonNullable<Json>
          processed_at: string | null
          processing_status: string
          provider: string
          provider_event_id: string
          provider_reference: string | null
          received_at: string
          result: Json | null
          tenant_id: string | null
        }
        ComputedFields: never
        Insert: {
          error_summary?: string | null
          event_type?: string | null
          id?: string
          payload?: NonNullable<Json>
          processed_at?: string | null
          processing_status?: string
          provider: string
          provider_event_id: string
          provider_reference?: string | null
          received_at?: string
          result?: Json | null
          tenant_id?: string | null
        }
        Update: {
          error_summary?: string | null
          event_type?: string | null
          id?: string
          payload?: NonNullable<Json>
          processed_at?: string | null
          processing_status?: string
          provider?: string
          provider_event_id?: string
          provider_reference?: string | null
          received_at?: string
          result?: Json | null
          tenant_id?: string | null
        }
        Relationships: []
      }
      payment_provider_accounts: {
        Row: {
          account_label: string
          created_at: string
          id: string
          mode: string
          provider: string
          public_configuration: NonNullable<Json>
          secret_reference: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          account_label: string
          created_at?: string
          id?: string
          mode: string
          provider: string
          public_configuration?: NonNullable<Json>
          secret_reference?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_label?: string
          created_at?: string
          id?: string
          mode?: string
          provider?: string
          public_configuration?: NonNullable<Json>
          secret_reference?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_provider_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_minor: number
          attempt_id: string | null
          created_at: string
          currency: string
          id: string
          internal_reference: string
          note: string | null
          payment_method: string
          payment_provider: string
          payment_status: string
          property_id: string
          provider_reference: string | null
          received_at: string
          recorded_by: string | null
          reservation_id: string
          tenant_id: string
          updated_at: string
          verification_note: string | null
          verification_status: string
          verified_at: string | null
          verified_by: string | null
        }
        ComputedFields: never
        Insert: {
          amount_minor: number
          attempt_id?: string | null
          created_at?: string
          currency: string
          id?: string
          internal_reference: string
          note?: string | null
          payment_method: string
          payment_provider?: string
          payment_status?: string
          property_id: string
          provider_reference?: string | null
          received_at?: string
          recorded_by?: string | null
          reservation_id: string
          tenant_id: string
          updated_at?: string
          verification_note?: string | null
          verification_status?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          amount_minor?: number
          attempt_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          internal_reference?: string
          note?: string | null
          payment_method?: string
          payment_provider?: string
          payment_status?: string
          property_id?: string
          provider_reference?: string | null
          received_at?: string
          recorded_by?: string | null
          reservation_id?: string
          tenant_id?: string
          updated_at?: string
          verification_note?: string | null
          verification_status?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "payment_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_property_id_reservation_id_fkey"
            columns: ["tenant_id", "property_id", "reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      permissions: {
        Row: {
          id: string
          key: string
        }
        ComputedFields: never
        Insert: {
          id?: string
          key: string
        }
        Update: {
          id?: string
          key?: string
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          created_at: string
          level: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          level?: string
          user_id: string
        }
        Update: {
          created_at?: string
          level?: string
          user_id?: string
        }
        Relationships: []
      }
      properties: {
        Row: {
          address: string | null
          check_in_time: string
          check_out_time: string
          city: string
          code: string
          contact_email: string | null
          country_code: string
          created_at: string
          currency: string
          id: string
          intro: string | null
          name: string
          phone: string | null
          state: string
          status: string
          tenant_id: string
          timezone: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          address?: string | null
          check_in_time?: string
          check_out_time?: string
          city?: string
          code: string
          contact_email?: string | null
          country_code?: string
          created_at?: string
          currency?: string
          id?: string
          intro?: string | null
          name: string
          phone?: string | null
          state?: string
          status?: string
          tenant_id: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          check_in_time?: string
          check_out_time?: string
          city?: string
          code?: string
          contact_email?: string | null
          country_code?: string
          created_at?: string
          currency?: string
          id?: string
          intro?: string | null
          name?: string
          phone?: string | null
          state?: string
          status?: string
          tenant_id?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "properties_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      property_policies: {
        Row: {
          config: NonNullable<Json>
          created_at: string
          created_by: string | null
          effective_from: string
          id: string
          property_id: string
          tenant_id: string
          version: number
        }
        ComputedFields: never
        Insert: {
          config?: NonNullable<Json>
          created_at?: string
          created_by?: string | null
          effective_from: string
          id?: string
          property_id: string
          tenant_id: string
          version: number
        }
        Update: {
          config?: NonNullable<Json>
          created_at?: string
          created_by?: string | null
          effective_from?: string
          id?: string
          property_id?: string
          tenant_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "property_policies_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      rate_limit_hits: {
        Row: {
          hits: number
          key: string
          window_start: string
        }
        ComputedFields: never
        Insert: {
          hits?: number
          key: string
          window_start: string
        }
        Update: {
          hits?: number
          key?: string
          window_start?: string
        }
        Relationships: []
      }
      rate_plans: {
        Row: {
          cancellation_policy: NonNullable<Json>
          code: string
          created_at: string
          currency: string
          id: string
          is_default: boolean
          name: string
          payment_policy: NonNullable<Json>
          property_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          cancellation_policy?: NonNullable<Json>
          code: string
          created_at?: string
          currency?: string
          id?: string
          is_default?: boolean
          name: string
          payment_policy?: NonNullable<Json>
          property_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          cancellation_policy?: NonNullable<Json>
          code?: string
          created_at?: string
          currency?: string
          id?: string
          is_default?: boolean
          name?: string
          payment_policy?: NonNullable<Json>
          property_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_plans_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      refunds: {
        Row: {
          amount_minor: number
          attention_note: string | null
          completed_at: string | null
          created_at: string
          currency: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          details_retry_started_at: string | null
          failure_reason: string | null
          id: string
          internal_reference: string
          needs_bank_details: boolean
          payment_id: string
          payout_reference: string | null
          property_id: string
          provider_call_started_at: string | null
          provider_refund_id: string | null
          reason: string
          refund_status: string
          requested_by: string | null
          reservation_id: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          amount_minor: number
          attention_note?: string | null
          completed_at?: string | null
          created_at?: string
          currency: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          details_retry_started_at?: string | null
          failure_reason?: string | null
          id?: string
          internal_reference: string
          needs_bank_details?: boolean
          payment_id: string
          payout_reference?: string | null
          property_id: string
          provider_call_started_at?: string | null
          provider_refund_id?: string | null
          reason: string
          refund_status?: string
          requested_by?: string | null
          reservation_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount_minor?: number
          attention_note?: string | null
          completed_at?: string | null
          created_at?: string
          currency?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          details_retry_started_at?: string | null
          failure_reason?: string | null
          id?: string
          internal_reference?: string
          needs_bank_details?: boolean
          payment_id?: string
          payout_reference?: string | null
          property_id?: string
          provider_call_started_at?: string | null
          provider_refund_id?: string | null
          reason?: string
          refund_status?: string
          requested_by?: string | null
          reservation_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_tenant_id_payment_id_fkey"
            columns: ["tenant_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "refunds_tenant_id_property_id_reservation_id_fkey"
            columns: ["tenant_id", "property_id", "reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      reservation_nights: {
        Row: {
          id: string
          night_date: string
          rate_minor: number
          rate_source: string
          reservation_room_id: string
          tax_minor: number
          tenant_id: string
        }
        ComputedFields: never
        Insert: {
          id?: string
          night_date: string
          rate_minor: number
          rate_source: string
          reservation_room_id: string
          tax_minor?: number
          tenant_id: string
        }
        Update: {
          id?: string
          night_date?: string
          rate_minor?: number
          rate_source?: string
          reservation_room_id?: string
          tax_minor?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservation_nights_reservation_room_id_fkey"
            columns: ["reservation_room_id"]
            isOneToOne: false
            referencedRelation: "reservation_rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_nights_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      reservation_rooms: {
        Row: {
          adults: number
          checked_in_at: string | null
          checked_out_at: string | null
          children: number
          created_at: string
          id: string
          property_id: string
          rate_plan_id: string
          requested_room_id: string | null
          reservation_id: string
          room_status: string
          room_type_id: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          adults: number
          checked_in_at?: string | null
          checked_out_at?: string | null
          children?: number
          created_at?: string
          id?: string
          property_id: string
          rate_plan_id: string
          requested_room_id?: string | null
          reservation_id: string
          room_status?: string
          room_type_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          adults?: number
          checked_in_at?: string | null
          checked_out_at?: string | null
          children?: number
          created_at?: string
          id?: string
          property_id?: string
          rate_plan_id?: string
          requested_room_id?: string | null
          reservation_id?: string
          room_status?: string
          room_type_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservation_rooms_tenant_id_property_id_rate_plan_id_fkey"
            columns: ["tenant_id", "property_id", "rate_plan_id"]
            isOneToOne: false
            referencedRelation: "rate_plans"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
          {
            foreignKeyName: "reservation_rooms_tenant_id_property_id_requested_room_id_fkey"
            columns: ["tenant_id", "property_id", "requested_room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
          {
            foreignKeyName: "reservation_rooms_tenant_id_property_id_reservation_id_fkey"
            columns: ["tenant_id", "property_id", "reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
          {
            foreignKeyName: "reservation_rooms_tenant_id_property_id_room_type_id_fkey"
            columns: ["tenant_id", "property_id", "room_type_id"]
            isOneToOne: false
            referencedRelation: "room_types"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      reservations: {
        Row: {
          arrival_date: string
          attention_reason: string | null
          booking_reference: string
          cancel_reason: string | null
          cancellation_charge_minor: number
          cancelled_at: string | null
          created_at: string
          created_by: string | null
          currency: string
          departure_date: string
          discount_amount_minor: number | null
          discount_minor: number
          discount_percent: number | null
          discount_reason: string | null
          guest_links_valid_from: string | null
          early_checkout_credit_minor: number
          id: string
          no_show_at: string | null
          payment_status: string
          policy_snapshot: NonNullable<Json>
          primary_guest_id: string
          property_id: string
          reservation_status: string
          source: string
          subtotal_minor: number
          tax_minor: number
          tenant_id: string
          total_minor: number
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          arrival_date: string
          attention_reason?: string | null
          booking_reference: string
          cancel_reason?: string | null
          cancellation_charge_minor?: number
          cancelled_at?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          departure_date: string
          discount_amount_minor?: number | null
          discount_minor?: number
          discount_percent?: number | null
          discount_reason?: string | null
          guest_links_valid_from?: string | null
          early_checkout_credit_minor?: number
          id?: string
          no_show_at?: string | null
          payment_status?: string
          policy_snapshot?: NonNullable<Json>
          primary_guest_id: string
          property_id: string
          reservation_status?: string
          source: string
          subtotal_minor?: number
          tax_minor?: number
          tenant_id: string
          total_minor?: number
          updated_at?: string
        }
        Update: {
          arrival_date?: string
          attention_reason?: string | null
          booking_reference?: string
          cancel_reason?: string | null
          cancellation_charge_minor?: number
          cancelled_at?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          departure_date?: string
          discount_amount_minor?: number | null
          discount_minor?: number
          discount_percent?: number | null
          discount_reason?: string | null
          guest_links_valid_from?: string | null
          early_checkout_credit_minor?: number
          id?: string
          no_show_at?: string | null
          payment_status?: string
          policy_snapshot?: NonNullable<Json>
          primary_guest_id?: string
          property_id?: string
          reservation_status?: string
          source?: string
          subtotal_minor?: number
          tax_minor?: number
          tenant_id?: string
          total_minor?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservations_tenant_id_primary_guest_id_fkey"
            columns: ["tenant_id", "primary_guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "reservations_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          permission_id: string
          role_id: string
        }
        ComputedFields: never
        Insert: {
          permission_id: string
          role_id: string
        }
        Update: {
          permission_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          id: string
          is_system: boolean
          key: string
          name: string
          tenant_id: string | null
        }
        ComputedFields: never
        Insert: {
          id?: string
          is_system?: boolean
          key: string
          name: string
          tenant_id?: string | null
        }
        Update: {
          id?: string
          is_system?: boolean
          key?: string
          name?: string
          tenant_id?: string | null
        }
        Relationships: []
      }
      room_inventory_claims: {
        Row: {
          block_reason: string | null
          claim_type: string
          created_at: string
          created_by: string | null
          end_date: string
          hold_expires_at: string | null
          id: string
          property_id: string
          reservation_room_id: string | null
          room_id: string
          start_date: string
          status: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          block_reason?: string | null
          claim_type: string
          created_at?: string
          created_by?: string | null
          end_date: string
          hold_expires_at?: string | null
          id?: string
          property_id: string
          reservation_room_id?: string | null
          room_id: string
          start_date: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          block_reason?: string | null
          claim_type?: string
          created_at?: string
          created_by?: string | null
          end_date?: string
          hold_expires_at?: string | null
          id?: string
          property_id?: string
          reservation_room_id?: string | null
          room_id?: string
          start_date?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claims_reservation_room_fk"
            columns: ["reservation_room_id"]
            isOneToOne: false
            referencedRelation: "reservation_rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_inventory_claims_tenant_id_property_id_room_id_fkey"
            columns: ["tenant_id", "property_id", "room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      room_type_photos: {
        Row: {
          caption: string | null
          content_type: string
          created_at: string
          id: string
          property_id: string
          room_type_id: string
          size_bytes: number
          sort_order: number
          storage_path: string
          tenant_id: string
        }
        ComputedFields: never
        Insert: {
          caption?: string | null
          content_type: string
          created_at?: string
          id?: string
          property_id: string
          room_type_id: string
          size_bytes: number
          sort_order?: number
          storage_path: string
          tenant_id: string
        }
        Update: {
          caption?: string | null
          content_type?: string
          created_at?: string
          id?: string
          property_id?: string
          room_type_id?: string
          size_bytes?: number
          sort_order?: number
          storage_path?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_type_photos_room_type_fkey"
            columns: ["tenant_id", "property_id", "room_type_id"]
            isOneToOne: false
            referencedRelation: "room_types"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      room_types: {
        Row: {
          amenities: string[]
          base_rate_minor: number
          bed_config: NonNullable<Json>
          code: string
          created_at: string
          currency: string
          description: string | null
          id: string
          is_public: boolean
          max_adults: number
          max_children: number
          max_occupancy: number
          name: string
          property_id: string
          slug: string
          status: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          amenities?: string[]
          base_rate_minor: number
          bed_config?: NonNullable<Json>
          code: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_public?: boolean
          max_adults: number
          max_children?: number
          max_occupancy: number
          name: string
          property_id: string
          slug: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amenities?: string[]
          base_rate_minor?: number
          bed_config?: NonNullable<Json>
          code?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_public?: boolean
          max_adults?: number
          max_children?: number
          max_occupancy?: number
          name?: string
          property_id?: string
          slug?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_types_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      rooms: {
        Row: {
          created_at: string
          floor: number | null
          housekeeping_status: string
          id: string
          operational_status: string
          property_id: string
          room_number: string
          room_type_id: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          floor?: number | null
          housekeeping_status?: string
          id?: string
          operational_status?: string
          property_id: string
          room_number: string
          room_type_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          floor?: number | null
          housekeeping_status?: string
          id?: string
          operational_status?: string
          property_id?: string
          room_number?: string
          room_type_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rooms_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "rooms_tenant_id_property_id_room_type_id_fkey"
            columns: ["tenant_id", "property_id", "room_type_id"]
            isOneToOne: false
            referencedRelation: "room_types"
            referencedColumns: ["tenant_id", "property_id", "id"]
          },
        ]
      }
      tax_rules: {
        Row: {
          applies_to_charges: boolean
          basis: string
          compounds: boolean
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          name: string
          property_id: string
          rate_value: number
          sequence: number
          status: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          applies_to_charges?: boolean
          basis: string
          compounds?: boolean
          created_at?: string
          effective_from: string
          effective_to?: string | null
          id?: string
          name: string
          property_id: string
          rate_value: number
          sequence?: number
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          applies_to_charges?: boolean
          basis?: string
          compounds?: boolean
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          name?: string
          property_id?: string
          rate_value?: number
          sequence?: number
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_rules_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      tenant_domains: {
        Row: {
          created_at: string
          host: string
          id: string
          is_primary: boolean
          property_id: string | null
          tenant_id: string
          verified_at: string | null
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          host: string
          id?: string
          is_primary?: boolean
          property_id?: string | null
          tenant_id: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          host?: string
          id?: string
          is_primary?: boolean
          property_id?: string | null
          tenant_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_domains_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_domains_tenant_id_property_id_fkey"
            columns: ["tenant_id", "property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      tenant_feature_entitlements: {
        Row: {
          configuration: NonNullable<Json>
          created_at: string
          enabled: boolean
          feature_key: string
          id: string
          tenant_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          configuration?: NonNullable<Json>
          created_at?: string
          enabled?: boolean
          feature_key: string
          id?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          configuration?: NonNullable<Json>
          created_at?: string
          enabled?: boolean
          feature_key?: string
          id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_feature_entitlements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_memberships: {
        Row: {
          created_at: string
          id: string
          status: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          status?: string
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_memberships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_subscriptions: {
        Row: {
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          plan_code: string
          status: string
          tenant_id: string
          trial_ends_at: string | null
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan_code: string
          status?: string
          tenant_id: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan_code?: string
          status?: string
          tenant_id?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          default_currency: string
          id: string
          name: string
          slug: string
          status: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          default_currency?: string
          id?: string
          name: string
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_currency?: string
          id?: string
          name?: string
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          avatar_path: string | null
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          avatar_path?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_path?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      room_board_claims_view: {
        Row: {
          block_reason: string | null
          checked_in: boolean | null
          claim_type: string | null
          end_date: string | null
          id: string | null
          property_id: string | null
          reservation_room_id: string | null
          room_id: string | null
          start_date: string | null
        }
        ComputedFields: never
        Relationships: []
      }
      room_board_view: {
        Row: {
          floor: number | null
          housekeeping_status: string | null
          id: string | null
          operational_status: string | null
          property_id: string | null
          room_number: string | null
          room_type_id: string | null
          room_type_name: string | null
        }
        ComputedFields: never
        Relationships: []
      }
    }
    Functions: {
      add_staff_member: {
        Args: {
          p_property: string
          p_role_key: string
          p_tenant: string
          p_user: string
        }
        Returns: Json
      }
      amenities_valid: { Args: { a: string[] }; Returns: boolean }
      apply_discount_amount: {
        Args: {
          p_amount_minor: number
          p_idempotency_key: string
          p_reason: string
          p_reservation_id: string
        }
        Returns: Json
      }
      apply_discount: {
        Args: {
          p_idempotency_key: string
          p_percent: number
          p_reason: string
          p_reservation_id: string
        }
        Returns: Json
      }
      allocate_payments_to_invoice: {
        Args: { p_invoice: string }
        Returns: number
      }
      approve_refund: {
        Args: {
          p_approve: boolean
          p_idempotency_key: string
          p_note: string
          p_refund_id: string
        }
        Returns: Json
      }
      assign_housekeeping_task: {
        Args: { p_task_id: string; p_user_id: string }
        Returns: Json
      }
      assign_maintenance_request: {
        Args: { p_request_id: string; p_user_id: string }
        Returns: Json
      }
      audit_actor_names: {
        Args: { p_user_ids: string[] }
        Returns: {
          name: string
          user_id: string
        }[]
      }
      begin_refund_processing: { Args: { p_refund_id: string }; Returns: Json }
      calc_charge_tax: {
        Args: { p_amount: number; p_date: string; p_property: string }
        Returns: number
      }
      calc_night_tax: {
        Args: { p_night: string; p_property: string; p_rate: number }
        Returns: number
      }
      can_view_money: { Args: { p_property: string }; Returns: boolean }
      can_view_tenant_audit: { Args: { p_tenant: string }; Returns: boolean }
      cancel_housekeeping_task: {
        Args: { p_reason: string; p_task_id: string }
        Returns: Json
      }
      cancel_maintenance_request: {
        Args: { p_reason: string; p_request_id: string }
        Returns: Json
      }
      cancel_reservation: {
        Args: {
          p_idempotency_key: string
          p_reason: string
          p_reservation_id: string
        }
        Returns: Json
      }
      cancel_reservation_apply: {
        Args: {
          p_actor: string
          p_by: string
          p_expected_charge?: number
          p_idempotency_key: string
          p_reason: string
          p_reservation_id: string
          p_waive?: boolean
        }
        Returns: Json
      }
      cancellation_quote: { Args: { p_reservation: string }; Returns: Json }
      change_room_type: {
        Args: {
          p_effective: string
          p_idempotency_key: string
          p_new_room_type: string
          p_reason: string
          p_reservation_room_id: string
        }
        Returns: Json
      }
      channel_report: {
        Args: { p_from: string; p_property_id: string; p_to: string }
        Returns: Json
      }
      check_in: {
        Args: { p_override_reason?: string; p_reservation_room_id: string }
        Returns: Json
      }
      check_out: {
        Args: { p_override_reason?: string; p_reservation_room_id: string }
        Returns: Json
      }
      claim_emails: { Args: { p_limit?: number }; Returns: Json }
      claim_housekeeping_task: { Args: { p_task_id: string }; Returns: Json }
      claim_maintenance_request: {
        Args: { p_request_id: string }
        Returns: Json
      }
      claim_room: {
        Args: {
          p_block_reason?: string
          p_claim_type: string
          p_created_by?: string
          p_end: string
          p_hold_expires_at?: string
          p_property_id: string
          p_requested_room_id: string
          p_reservation_room_id: string
          p_room_type_id: string
          p_start: string
        }
        Returns: string
      }
      complete_housekeeping_task: {
        Args: { p_note?: string; p_task_id: string }
        Returns: Json
      }
      confirm_payment: {
        Args: {
          p_amount_minor: number
          p_channel: string
          p_currency: string
          p_event_id: string
          p_event_type: string
          p_payload?: Json
          p_provider: string
          p_reference: string
          p_status: string
          p_tenant_id?: string
        }
        Returns: Json
      }
      consume_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: Json
      }
      create_hold: {
        Args: {
          p_arrival: string
          p_departure: string
          p_guest: Json
          p_host: string
          p_idempotency_key: string
          p_rooms: Json
        }
        Returns: Json
      }
      create_housekeeping_task: {
        Args: {
          p_assigned_to?: string
          p_due_at?: string
          p_notes?: string
          p_priority?: string
          p_room_id: string
          p_task_type?: string
        }
        Returns: Json
      }
      create_payment_attempt: {
        Args: { p_idempotency_key: string; p_reservation_id: string }
        Returns: Json
      }
      create_reservation: {
        Args: {
          p_arrival: string
          p_departure: string
          p_idempotency_key: string
          p_primary_guest_id: string
          p_property_id: string
          p_rooms: Json
          p_source: string
        }
        Returns: Json
      }
      create_room_block: {
        Args: {
          p_end: string
          p_idempotency_key: string
          p_reason: string
          p_resolution: string
          p_room_id: string
          p_start: string
        }
        Returns: Json
      }
      create_staff_hold: {
        Args: {
          p_arrival: string
          p_departure: string
          p_idempotency_key: string
          p_primary_guest_id: string
          p_property_id: string
          p_rooms: Json
          p_source: string
        }
        Returns: Json
      }
      current_policy: {
        Args: { p_on: string; p_property: string }
        Returns: Json
      }
      daily_report: {
        Args: { p_from: string; p_property: string; p_to: string }
        Returns: {
          cash_in_minor: number
          day: string
          extras_minor: number
          extras_tax_minor: number
          refunds_paid_minor: number
          room_revenue_minor: number
          room_tax_minor: number
          rooms_available: number
          rooms_sold: number
        }[]
      }
      early_check_in: { Args: { p_reason: string; p_reservation_room_id: string; p_waive?: boolean }; Returns: Json }
      early_checkin_quote: { Args: { p_reservation_room_id: string }; Returns: Json }
      early_checkout_quote: { Args: { p_reservation_room_id: string }; Returns: Json }
      email_folio_invoice: {
        Args: { p_idempotency_key: string; p_invoice_id: string }
        Returns: Json
      }
      enqueue_booking_email: {
        Args: {
          p_dedupe: string
          p_kind: string
          p_payload?: Json
          p_reservation: string
        }
        Returns: boolean
      }
      expire_lapsed_holds: { Args: { p_limit?: number }; Returns: number }
      find_processing_refund: {
        Args: {
          p_amount_minor: number
          p_provider: string
          p_tenant_id: string
          p_transaction_reference: string
        }
        Returns: string
      }
      find_user_id_by_email: { Args: { p_email: string }; Returns: string }
      finish_refund_details_retry: {
        Args: { p_note: string; p_outcome: string; p_refund_id: string }
        Returns: undefined
      }
      folio_balance: { Args: { p_reservation_id: string }; Returns: Json }
      folio_totals: {
        Args: { p_reservation: string }
        Returns: Record<string, unknown>
      }
      guest_change_dates: {
        Args: {
          p_arrival: string
          p_departure: string
          p_expected_total_minor: number
          p_idempotency_key: string
          p_reservation_id: string
        }
        Returns: Json
      }
      guest_change_dates_quote: {
        Args: { p_arrival: string; p_departure: string; p_reservation_id: string }
        Returns: Json
      }
      guest_change_options: {
        Args: { p_reservation_id: string }
        Returns: Json
      }
      guest_link_ok: {
        Args: { p_issued_at: number; p_reservation_id: string }
        Returns: boolean
      }
      guest_booking_status: {
        Args: { p_reservation_id: string }
        Returns: Json
      }
      guest_cancel_preview: {
        Args: { p_reservation_id: string }
        Returns: Json
      }
      guest_cancel_reservation: {
        Args: {
          p_expected_charge_minor: number
          p_idempotency_key: string
          p_reservation_id: string
        }
        Returns: Json
      }
      guest_hotel: { Args: { p_host: string }; Returns: Json }
      guest_policy: { Args: { p_host: string }; Returns: Json }
      guest_report: {
        Args: { p_from: string; p_property_id: string; p_to: string }
        Returns: Json
      }
      guest_request_change: {
        Args: {
          p_arrival: string
          p_departure: string
          p_idempotency_key: string
          p_kind: string
          p_message: string
          p_reservation_id: string
        }
        Returns: Json
      }
      guest_update_contact: {
        Args: { p_idempotency_key: string; p_phone: string; p_reservation_id: string }
        Returns: Json
      }
      create_custom_role: {
        Args: { p_name: string; p_permissions: string[]; p_tenant: string }
        Returns: Json
      }
      custom_roles_list: {
        Args: { p_tenant: string }
        Returns: Json
      }
      delete_custom_role: {
        Args: { p_role: string }
        Returns: Json
      }
      update_custom_role: {
        Args: { p_name: string; p_permissions: string[]; p_role: string }
        Returns: Json
      }
      guest_withdraw_change_request: {
        Args: { p_reservation_id: string }
        Returns: Json
      }
      has_permission: {
        Args: { p_permission: string; p_property: string }
        Returns: boolean
      }
      has_tenant_permission: {
        Args: { p_permission: string; p_tenant: string }
        Returns: boolean
      }
      hk_require: {
        Args: { p_deny_as?: string; p_permission: string; p_property: string }
        Returns: string
      }
      hk_task_json: {
        Args: {
          t: Omit<
            Database["public"]["Tables"]["housekeeping_tasks"]["Row"],
            Database["public"]["Tables"]["housekeeping_tasks"]["ComputedFields"]
          >
        }
        Returns: Json
      }
      hk_user_can: {
        Args: { p_permission: string; p_property: string; p_user: string }
        Returns: boolean
      }
      idem_begin: {
        Args: {
          p_hash: string
          p_key: string
          p_operation: string
          p_tenant: string
        }
        Returns: Record<string, unknown>
      }
      idem_finish: {
        Args: {
          p_key: string
          p_operation: string
          p_response: Json
          p_tenant: string
        }
        Returns: undefined
      }
      is_system_caller: { Args: Record<PropertyKey, never>; Returns: boolean }
      issue_folio_invoice: {
        Args: { p_idempotency_key: string; p_reservation_id: string }
        Returns: Json
      }
      issue_invoice: {
        Args: { p_idempotency_key: string; p_reservation_id: string }
        Returns: Json
      }
      link_maintenance_block: {
        Args: { p_block_id: string; p_request_id: string }
        Returns: Json
      }
      list_housekeeping_staff: {
        Args: { p_property: string }
        Returns: {
          full_name: string
          user_id: string
        }[]
      }
      list_maintenance_staff: {
        Args: { p_property: string }
        Returns: {
          full_name: string
          user_id: string
        }[]
      }
      move_room_type_photo: { Args: { p_direction: string; p_photo: string }; Returns: number }
      update_hotel_profile: { Args: { p_email: string; p_intro: string; p_phone: string; p_property: string }; Returns: undefined }
      claim_photo_cleanup: { Args: { p_limit?: number }; Returns: string[] }
      finish_photo_cleanup: { Args: { p_paths: string[] }; Returns: number }
      update_hotel_basics: { Args: { p_address: string; p_check_in: string; p_check_out: string; p_city: string; p_name: string; p_property: string; p_state: string }; Returns: undefined }
      lock_room_types: {
        Args: { p_property: string; p_types: string[] }
        Returns: undefined
      }
      mark_email_result: {
        Args: { p_error?: string; p_id: string; p_ok: boolean }
        Returns: undefined
      }
      mark_no_show: {
        Args: {
          p_idempotency_key: string
          p_note: string
          p_reservation_id: string
          p_waive_charge: boolean
        }
        Returns: Json
      }
      mark_notification_read: { Args: { p_id: string }; Returns: undefined }
      mark_notifications_read: { Args: { p_category?: string }; Returns: number }
      mark_refund_needs_details: {
        Args: {
          p_note: string
          p_provider_refund_id: string
          p_refund_id: string
        }
        Returns: undefined
      }
      mt_request_json: {
        Args: {
          r: Omit<
            Database["public"]["Tables"]["maintenance_requests"]["Row"],
            Database["public"]["Tables"]["maintenance_requests"]["ComputedFields"]
          >
        }
        Returns: Json
      }
      my_tenant_ids: { Args: Record<PropertyKey, never>; Returns: string[] }
      new_booking_reference: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      no_show_list: {
        Args: { p_from: string; p_property_id: string; p_to: string }
        Returns: Json
      }
      note_refund_attention: {
        Args: { p_note: string; p_refund_id: string }
        Returns: undefined
      }
      notification_inbox: {
        Args: { p_before?: string; p_category?: string; p_limit?: number; p_only_unread?: boolean }
        Returns: Json
      }
      notification_unread_count: { Args: never; Returns: number }
      notifications_sweep: { Args: never; Returns: Json }
      occupancy_report: {
        Args: { p_from: string; p_property_id: string; p_to: string }
        Returns: Json
      }
      payment_provider_account_for_webhook: {
        Args: { p_account_id: string }
        Returns: {
          mode: string
          provider: string
          secret_reference: string
          tenant_id: string
        }[]
      }
      payment_start_context: {
        Args: { p_reservation_id: string }
        Returns: Json
      }
      payments_to_verify: { Args: { p_limit?: number; p_status?: string }; Returns: Json }
      pending_required_minor: {
        Args: { p_reservation: string }
        Returns: number
      }
      policy_config_valid: { Args: { p: Json }; Returns: boolean }
      platform_add_domain: {
        Args: { p_host: string; p_property: string; p_tenant: string }
        Returns: Json
      }
      platform_create_tenant: {
        Args: {
          p_city: string
          p_currency: string
          p_host: string
          p_name: string
          p_owner_user_id: string
          p_paystack_mode: string
          p_paystack_secret_reference: string
          p_property_code: string
          p_property_name: string
          p_slug: string
          p_state: string
          p_timezone: string
        }
        Returns: Json
      }
      platform_level: { Args: Record<PropertyKey, never>; Returns: string }
      platform_list_tenants: { Args: Record<PropertyKey, never>; Returns: Json }
      platform_require: { Args: { p_min: string }; Returns: string }
      platform_set_domain_verified: {
        Args: { p_domain: string; p_verified: boolean }
        Returns: Json
      }
      platform_log_owner_invite: {
        Args: { p_tenant: string; p_user: string }
        Returns: undefined
      }
      platform_owner_invite_check: {
        Args: { p_tenant: string; p_user: string }
        Returns: Json
      }
      platform_set_entitlement: {
        Args: { p_enabled: boolean; p_feature_key: string; p_tenant: string }
        Returns: Json
      }
      platform_set_provider_status: {
        Args: { p_account: string; p_status: string }
        Returns: Json
      }
      platform_set_subscription: {
        Args: {
          p_period_end: string
          p_plan_code: string
          p_status: string
          p_tenant: string
          p_trial_ends_at: string
        }
        Returns: Json
      }
      platform_set_tenant_status: {
        Args: { p_reason: string; p_status: string; p_tenant: string }
        Returns: Json
      }
      platform_tenant_detail: { Args: { p_tenant: string }; Returns: Json }
      post_folio_charge: {
        Args: {
          p_category: string
          p_charge_date?: string
          p_description: string
          p_idempotency_key: string
          p_quantity: number
          p_reservation_id: string
          p_reservation_room_id?: string
          p_unit_amount_minor: number
        }
        Returns: Json
      }
      property_today: { Args: { p_property: string }; Returns: string }
      purge_old_operational_data: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      record_folio_payment: {
        Args: {
          p_amount_minor: number
          p_idempotency_key: string
          p_method: string
          p_note: string
          p_reference: string
          p_reservation_id: string
        }
        Returns: Json
      }
      record_manual_payment: {
        Args: {
          p_amount_minor: number
          p_idempotency_key: string
          p_method: string
          p_note: string
          p_reference: string
          p_reservation_id: string
        }
        Returns: Json
      }
      record_manual_refund: {
        Args: {
          p_idempotency_key: string
          p_payout_reference: string
          p_refund_id: string
        }
        Returns: Json
      }
      record_refund_result: {
        Args: {
          p_event_id: string
          p_failure_reason?: string
          p_payload?: Json
          p_provider: string
          p_provider_refund_id: string
          p_refund_id: string
          p_status: string
        }
        Returns: Json
      }
      refresh_invoice_status: {
        Args: { p_invoice: string }
        Returns: undefined
      }
      refresh_money_state: {
        Args: { p_reservation: string }
        Returns: undefined
      }
      refresh_reservation_payment_status: {
        Args: { p_reservation: string }
        Returns: undefined
      }
      refund_payout_context: { Args: { p_refund_id: string }; Returns: Json }
      release_expired_holds: {
        Args: { p_end: string; p_property_id: string; p_start: string }
        Returns: number
      }
      release_room_block: { Args: { p_block_id: string }; Returns: Json }
      remove_staff_role: { Args: { p_membership_role: string }; Returns: Json }
      report_maintenance_request: {
        Args: {
          p_assigned_to: string
          p_description: string
          p_due_at: string
          p_idempotency_key: string
          p_location: string
          p_priority: string
          p_property_id: string
          p_room_id: string
          p_title: string
        }
        Returns: Json
      }
      reset_guest_links: {
        Args: { p_idempotency_key: string; p_reason: string; p_reservation_id: string }
        Returns: Json
      }
      request_booking_link: {
        Args: { p_email: string; p_host: string; p_reference: string }
        Returns: boolean
      }
      request_refund: {
        Args: {
          p_amount_minor: number
          p_idempotency_key: string
          p_payment_id: string
          p_reason: string
        }
        Returns: Json
      }
      require_permission: {
        Args: { p_deny_as?: string; p_permission: string; p_property: string }
        Returns: string
      }
      resend_email: { Args: { p_email_id: string }; Returns: Json }
      reservation_money_held: {
        Args: { p_reservation: string }
        Returns: number
      }
      reservation_settlement: {
        Args: { p_reservation_id: string }
        Returns: Json
      }
      resolve_change_request: {
        Args: { p_note: string; p_outcome: string; p_request_id: string }
        Returns: Json
      }
      resolve_host: {
        Args: { p_host: string }
        Returns: {
          property_id: string
          tenant_id: string
        }[]
      }
      resolve_maintenance_request: {
        Args: { p_note?: string; p_request_id: string }
        Returns: Json
      }
      resolve_rate: {
        Args: {
          p_night: string
          p_property: string
          p_rate_plan: string
          p_room_type: string
        }
        Returns: {
          amount_minor: number
          source: string
        }[]
      }
      reverse_folio_payment: {
        Args: { p_payment_id: string; p_reason: string }
        Returns: Json
      }
      reverse_payment: {
        Args: {
          p_idempotency_key: string
          p_payment_id: string
          p_reason: string
        }
        Returns: Json
      }
      search_availability: {
        Args: {
          p_adults: number
          p_arrival: string
          p_children?: number
          p_departure: string
          p_host: string
        }
        Returns: Json
      }
      set_discount_cap: {
        Args: { p_percent: number; p_property_id: string; p_role_key: string }
        Returns: Json
      }
      set_housekeeping_status: {
        Args: { p_room_id: string; p_status: string }
        Returns: Json
      }
      set_maintenance_priority: {
        Args: { p_priority: string; p_request_id: string }
        Returns: Json
      }
      set_staff_status: {
        Args: { p_membership: string; p_status: string }
        Returns: Json
      }
      settle_cancelled_reservation: {
        Args: { p_actor: string; p_reservation: string }
        Returns: Json
      }
      staff_actor_covers: {
        Args: {
          p_actor: string
          p_property: string
          p_role: string
          p_tenant: string
        }
        Returns: boolean
      }
      staff_actor_manages: {
        Args: { p_actor: string; p_tenant: string }
        Returns: boolean
      }
      staff_assert_can_grant: {
        Args: {
          p_actor: string
          p_property: string
          p_role_key: string
          p_tenant: string
        }
        Returns: string
      }
      staff_check_grant: {
        Args: { p_property: string; p_role_key: string; p_tenant: string }
        Returns: undefined
      }
      staff_directory: { Args: Record<PropertyKey, never>; Returns: Json }
      staff_failed_emails: { Args: { p_limit?: number }; Returns: Json }
      staff_other_active_owner: {
        Args: { p_membership: string; p_tenant: string }
        Returns: boolean
      }
      stale_processing_refunds: {
        Args: { p_older_than_minutes?: number }
        Returns: Json
      }
      start_housekeeping_task: { Args: { p_task_id: string }; Returns: Json }
      start_maintenance_request: {
        Args: { p_request_id: string }
        Returns: Json
      }
      start_refund_details_retry: {
        Args: { p_refund_id: string }
        Returns: Json
      }
      start_refund_payout: { Args: { p_refund_id: string }; Returns: Json }
      transfer_claim_internal: {
        Args: {
          p_effective: string
          p_new_room: string
          p_reservation_room_id: string
        }
        Returns: Json
      }
      transfer_room: {
        Args: {
          p_effective: string
          p_idempotency_key: string
          p_new_room_id: string
          p_reason: string
          p_reservation_room_id: string
        }
        Returns: Json
      }
      update_guest: {
        Args: {
          p_address: string
          p_country_code: string
          p_email: string
          p_full_name: string
          p_guest: string
          p_phone: string
        }
        Returns: Json
      }
      update_reservation_stay: {
        Args: {
          p_arrival: string
          p_departure: string
          p_guests: Json
          p_idempotency_key: string
          p_reason: string
          p_reservation_id: string
        }
        Returns: Json
      }
      verify_payment: { Args: { p_note?: string; p_payment_id: string }; Returns: Json }
      void_folio_charge: {
        Args: { p_charge_id: string; p_reason: string }
        Returns: Json
      }
      void_folio_invoice: {
        Args: { p_invoice_id: string; p_reason: string }
        Returns: Json
      }
      void_invoice: {
        Args: {
          p_idempotency_key: string
          p_invoice_id: string
          p_reason: string
        }
        Returns: Json
      }
      write_audit: {
        Args: {
          p_action: string
          p_actor: string
          p_entity: string
          p_entity_type: string
          p_meta: Json
          p_property: string
          p_request: string
          p_tenant: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
