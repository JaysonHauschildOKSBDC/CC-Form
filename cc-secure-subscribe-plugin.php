<?php
/**
 * Plugin Name: CC Secure Subscribe Endpoint
 * Description: Secure Constant Contact subscription endpoint for frontend forms.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

class CCSecureSubscribeEndpoint {
    const OPTION_REFRESH_TOKEN = 'cc_secure_refresh_token';
    const OPTION_ACCESS_TOKEN = 'cc_secure_access_token';
    const OPTION_ACCESS_TOKEN_EXPIRES = 'cc_secure_access_token_expires';

    // Configure these values.
    const CLIENT_ID = 'YOUR_CLIENT_ID';
    const CLIENT_SECRET = 'YOUR_CLIENT_SECRET';
    const INITIAL_REFRESH_TOKEN = 'YOUR_INITIAL_REFRESH_TOKEN';

    const TOKEN_URL = 'https://authz.constantcontact.com/oauth2/default/v1/token';
    const SIGNUP_URL = 'https://api.cc.email/v3/contacts/sign_up_form';

    // Map public newsletter keys to private Constant Contact list IDs.
    private static $newsletter_map = array(
        'franchising' => array(
            'label' => 'Client List - Franchising',
            'list_id' => '06ebd53c-73cd-11f0-a3c1-fa163e76af05',
        ),
        'accounting' => array(
            'label' => 'Client List - Business Accounting/Budget',
            'list_id' => '0ce2ce38-73cc-11f0-bcdd-fa163e296d2b',
        ),
        'sba' => array(
            'label' => 'SBA Contact',
            'list_id' => '0e6b3870-18c2-11e8-b894-d4ae52a82222',
        ),
    );

    public static function init() {
        add_action('rest_api_init', array(__CLASS__, 'register_routes'));
        add_action('init', array(__CLASS__, 'bootstrap_refresh_token'));
    }

    public static function register_routes() {
        register_rest_route('cc/v1', '/newsletters', array(
            'methods' => 'GET',
            'callback' => array(__CLASS__, 'get_newsletters'),
            'permission_callback' => '__return_true',
        ));

        register_rest_route('cc/v1', '/subscribe', array(
            'methods' => 'POST',
            'callback' => array(__CLASS__, 'subscribe'),
            'permission_callback' => '__return_true',
        ));
    }

    public static function bootstrap_refresh_token() {
        $stored = get_option(self::OPTION_REFRESH_TOKEN);
        if (!$stored && self::INITIAL_REFRESH_TOKEN !== 'YOUR_INITIAL_REFRESH_TOKEN') {
            update_option(self::OPTION_REFRESH_TOKEN, self::INITIAL_REFRESH_TOKEN, false);
        }
    }

    public static function get_newsletters() {
        $newsletters = array();
        foreach (self::$newsletter_map as $key => $value) {
            $newsletters[] = array(
                'key' => $key,
                'label' => $value['label'],
            );
        }

        return rest_ensure_response(array(
            'newsletters' => $newsletters,
        ));
    }

    public static function subscribe(WP_REST_Request $request) {
        $data = $request->get_json_params();
        if (!is_array($data)) {
            return new WP_REST_Response(array('message' => 'Invalid JSON body.'), 400);
        }

        $email = isset($data['email']) ? sanitize_email($data['email']) : '';
        $first_name = isset($data['first_name']) ? sanitize_text_field($data['first_name']) : '';
        $last_name = isset($data['last_name']) ? sanitize_text_field($data['last_name']) : '';
        $company_name = isset($data['company_name']) ? sanitize_text_field($data['company_name']) : '';
        $consent = !empty($data['consent']);
        $newsletter_keys = isset($data['newsletter_keys']) && is_array($data['newsletter_keys']) ? $data['newsletter_keys'] : array();

        if (!$email) {
            return new WP_REST_Response(array('message' => 'Email is required.'), 400);
        }

        if (!$consent) {
            return new WP_REST_Response(array('message' => 'Consent is required.'), 400);
        }

        $list_ids = array();
        foreach ($newsletter_keys as $key) {
            $safe_key = sanitize_key($key);
            if (isset(self::$newsletter_map[$safe_key])) {
                $list_ids[] = self::$newsletter_map[$safe_key]['list_id'];
            }
        }

        $list_ids = array_values(array_unique($list_ids));
        if (empty($list_ids)) {
            return new WP_REST_Response(array('message' => 'Select at least one newsletter option.'), 400);
        }

        $access_token = self::get_valid_access_token();
        if (is_wp_error($access_token)) {
            return new WP_REST_Response(array('message' => $access_token->get_error_message()), 500);
        }

        $payload = array(
            'email_address' => $email,
            'first_name' => $first_name,
            'last_name' => $last_name,
            'company_name' => $company_name,
            'list_memberships' => $list_ids,
        );

        $response = wp_remote_post(self::SIGNUP_URL, array(
            'headers' => array(
                'Authorization' => 'Bearer ' . $access_token,
                'Content-Type' => 'application/json',
                'Accept' => 'application/json',
            ),
            'body' => wp_json_encode($payload),
            'timeout' => 20,
        ));

        if (is_wp_error($response)) {
            return new WP_REST_Response(array('message' => 'Constant Contact request failed.'), 500);
        }

        $status = wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);
        $decoded = json_decode($body, true);

        if ($status < 200 || $status >= 300) {
            return new WP_REST_Response(array(
                'message' => 'Constant Contact rejected the request.',
                'details' => $decoded,
            ), $status ?: 500);
        }

        return rest_ensure_response(array(
            'ok' => true,
            'result' => $decoded,
        ));
    }

    private static function get_valid_access_token() {
        $token = get_option(self::OPTION_ACCESS_TOKEN, '');
        $expires = (int) get_option(self::OPTION_ACCESS_TOKEN_EXPIRES, 0);
        $now = time();

        if ($token && $expires > ($now + 60)) {
            return $token;
        }

        return self::refresh_access_token();
    }

    private static function refresh_access_token() {
        $refresh_token = get_option(self::OPTION_REFRESH_TOKEN, '');
        if (!$refresh_token) {
            return new WP_Error('cc_missing_refresh', 'Missing refresh token. Set INITIAL_REFRESH_TOKEN in plugin code.');
        }

        $args = array(
            'grant_type' => 'refresh_token',
            'refresh_token' => $refresh_token,
            'client_id' => self::CLIENT_ID,
            'client_secret' => self::CLIENT_SECRET,
        );

        $response = wp_remote_post(self::TOKEN_URL, array(
            'headers' => array(
                'Content-Type' => 'application/x-www-form-urlencoded',
                'Accept' => 'application/json',
            ),
            'body' => http_build_query($args, '', '&'),
            'timeout' => 20,
        ));

        if (is_wp_error($response)) {
            return new WP_Error('cc_token_error', 'Token refresh request failed.');
        }

        $status = wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);
        $decoded = json_decode($body, true);

        if ($status < 200 || $status >= 300 || empty($decoded['access_token'])) {
            return new WP_Error('cc_token_invalid', 'Token refresh failed. Check CC credentials and refresh token.');
        }

        update_option(self::OPTION_ACCESS_TOKEN, $decoded['access_token'], false);

        if (!empty($decoded['expires_in'])) {
            update_option(self::OPTION_ACCESS_TOKEN_EXPIRES, time() + (int) $decoded['expires_in'], false);
        }

        if (!empty($decoded['refresh_token'])) {
            update_option(self::OPTION_REFRESH_TOKEN, $decoded['refresh_token'], false);
        }

        return $decoded['access_token'];
    }
}

CCSecureSubscribeEndpoint::init();
