<?php
/**
 * Plugin Name: Jaarevent Cancellation Webhook
 * Description: Sends a webhook to bot.ciiic.nl when a Gravity Forms registration status changes (e.g. cancelled).
 * Version: 1.0.0
 * 
 * Install: Copy to wp-content/mu-plugins/ on forms.ciiic.nl
 * 
 * Requires: Gravity Forms with GravityView Entry Approval or custom cancel link
 * that updates entry meta 'registration_status' to 'cancelled'.
 */

// Fire when entry status/meta changes
add_action('gform_update_meta', 'jaarevent_registration_status_webhook', 10, 4);

function jaarevent_registration_status_webhook($meta_id, $entry_id, $meta_key, $meta_value) {
    // Only act on registration status changes for form 13
    if ($meta_key !== 'registration_status') {
        return;
    }

    $entry = GFAPI::get_entry($entry_id);
    if (is_wp_error($entry) || (int) $entry['form_id'] !== 13) {
        return;
    }

    $email = rgar($entry, '2'); // Field 2 = email
    if (empty($email)) {
        return;
    }

    $webhook_url = 'https://bot.ciiic.nl/webhook/registration-status';
    $secret = defined('JAAREVENT_WEBHOOK_SECRET') ? JAAREVENT_WEBHOOK_SECRET : '';

    $payload = json_encode([
        'email'    => $email,
        'status'   => $meta_value, // 'cancelled', 'confirmed', etc.
        'entry_id' => $entry_id,
    ]);

    $headers = [
        'Content-Type' => 'application/json',
    ];

    if ($secret) {
        $headers['X-Webhook-Signature'] = hash_hmac('sha256', $payload, $secret);
    }

    wp_remote_post($webhook_url, [
        'body'    => $payload,
        'headers' => $headers,
        'timeout' => 10,
    ]);

    error_log("[Jaarevent] Webhook sent: {$email} → {$meta_value} (entry {$entry_id})");
}

/**
 * Alternative: Hook into Gravity Forms entry status change (trash/spam/active)
 * This catches when entries are trashed via admin or restore links.
 */
add_action('gform_update_status', 'jaarevent_entry_status_webhook', 10, 3);

function jaarevent_entry_status_webhook($entry_id, $status, $prev_status = '') {
    $entry = GFAPI::get_entry($entry_id);
    if (is_wp_error($entry) || (int) $entry['form_id'] !== 13) {
        return;
    }

    // Only fire for trash (cancellation via admin)
    if ($status !== 'trash') {
        return;
    }

    $email = rgar($entry, '2');
    if (empty($email)) {
        return;
    }

    $webhook_url = 'https://bot.ciiic.nl/webhook/registration-status';
    $secret = defined('JAAREVENT_WEBHOOK_SECRET') ? JAAREVENT_WEBHOOK_SECRET : '';

    $payload = json_encode([
        'email'    => $email,
        'status'   => 'cancelled',
        'entry_id' => $entry_id,
    ]);

    $headers = [
        'Content-Type' => 'application/json',
    ];

    if ($secret) {
        $headers['X-Webhook-Signature'] = hash_hmac('sha256', $payload, $secret);
    }

    wp_remote_post($webhook_url, [
        'body'    => $payload,
        'headers' => $headers,
        'timeout' => 10,
    ]);

    error_log("[Jaarevent] Cancel webhook sent: {$email} (entry {$entry_id} → trash)");
}
