#!/usr/bin/env python3
"""
Browser automation script using SeleniumBase UC mode to bypass Cloudflare Turnstile.
Outputs JSON with auth tokens to stdout.
"""

import sys
import json
import argparse
import time
import imaplib
import email as email_module
import re
import random
import string
from seleniumbase import SB
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys


def get_verification_code(gmail_addr, gmail_password, target_email, timeout=90):
    """Fetch verification code from Gmail via IMAP."""
    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com")
        mail.login(gmail_addr, gmail_password.replace(" ", ""))
        mail.select("INBOX")
        
        deadline = time.time() + timeout
        seen_uids = set()
        
        while time.time() < deadline:
            status, messages = mail.search(None, '(FROM "openai.com")')
            if status == "OK":
                uids = messages[0].split()
                for uid in reversed(uids):
                    if uid in seen_uids:
                        continue
                    seen_uids.add(uid)
                    
                    status, msg_data = mail.fetch(uid, "(RFC822)")
                    if status != "OK" or not msg_data or not isinstance(msg_data, list) or len(msg_data) == 0:
                        continue
                    
                    # msg_data is a list of tuples, each tuple is (response_part, data)
                    first_part = msg_data[0]
                    if not isinstance(first_part, tuple) or len(first_part) < 2:
                        continue
                    
                    msg_bytes = first_part[1]
                    if not isinstance(msg_bytes, bytes):
                        continue
                    
                    msg = email_module.message_from_bytes(msg_bytes)
                    
                    to_header = msg.get("To", "")
                    if target_email.lower() not in to_header.lower():
                        continue
                    
                    body = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            if part.get_content_type() == "text/plain":
                                payload = part.get_payload(decode=True)
                                if isinstance(payload, bytes):
                                    body += payload.decode("utf-8", errors="ignore")
                    else:
                        payload = msg.get_payload(decode=True)
                        if isinstance(payload, bytes):
                            body = payload.decode("utf-8", errors="ignore")
                    
                    codes = re.findall(r'\b(\d{6})\b', body)
                    valid_codes = [c for c in codes if not c.startswith("20")]
                    if valid_codes:
                        mail.close()
                        mail.logout()
                        return valid_codes[-1]
            
            time.sleep(3)
        
        mail.close()
        mail.logout()
    except Exception as e:
        print(f"Gmail error: {e}", file=sys.stderr)
    
    return None


def generate_password():
    chars = string.ascii_letters + string.digits + "!@#$%"
    return "".join(random.choice(chars) for _ in range(16))


def try_click(sb, selectors, timeout=2):
    for sel in selectors:
        try:
            sb.click(sel, timeout=timeout)
            return True
        except:
            continue
    # Fallback: try XPath selectors
    for sel in selectors:
        try:
            if "contains" in sel:
                # Convert :contains() to XPath
                text = sel.split("'")[1]
                xpath = f"//button[contains(text(), '{text}')]"
                sb.driver.find_element(By.XPATH, xpath).click()
                return True
        except:
            continue
    return False


def detect_error_page(driver):
    """Detect if we are on an error page and extract error message."""
    try:
        error_el = driver.find_element(By.XPATH, "//*[contains(text(), 'Oops, an error occurred')]")
        if error_el:
            # Find the error message within the gray box
            error_msg_el = driver.find_element(By.CSS_SELECTOR, '.error-message, [class*="error"]')
            error_msg = error_msg_el.text if error_msg_el else ''
            if not error_msg:
                # Try to get the paragraph inside the gray box
                gray_box = driver.find_element(By.CSS_SELECTOR, 'div[class*="bg-gray"], div[class*="error-box"]')
                error_msg = gray_box.text if gray_box else ''
            return True, error_msg
    except:
        pass
    return False, ''


def detect_existing_account(driver):
    """Detect if we are on password login page (account exists) or password creation page."""
    try:
        # Look for text that indicates login vs create
        page_text = driver.find_element(By.TAG_NAME, 'body').text
        if 'Enter your password' in page_text or 'Log in' in page_text:
            return 'login'
        elif 'Create your account' in page_text or 'Set your password' in page_text:
            return 'create'
    except:
        pass
    return None


def set_react_value(driver, element, value):
    """Set input value in a way that React recognizes it."""
    driver.execute_script("""
        const input = arguments[0];
        const value = arguments[1];
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    """, element, value)


def fill_name_field(driver):
    """Fill the name field using multiple strategies."""
    # Strategy 1: find input[name="name"] and use send_keys (native Selenium)
    try:
        name_input = driver.find_element(By.CSS_SELECTOR, 'input[name="name"]')
        name_input.click()
        time.sleep(0.3)
        # Select all and clear
        name_input.send_keys(Keys.CONTROL + 'a')
        time.sleep(0.2)
        name_input.send_keys(Keys.DELETE)
        time.sleep(0.2)
        # Type character by character
        name_input.send_keys("Test User")
        time.sleep(0.5)
        # Blur to trigger validation
        driver.execute_script("arguments[0].blur()", name_input)
        time.sleep(0.5)
        print("[Python] Name filled via send_keys", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[Python] Name send_keys failed: {e}", file=sys.stderr)
    
    # Strategy 2: React value setter
    try:
        name_input = driver.find_element(By.CSS_SELECTOR, 'input[name="name"]')
        set_react_value(driver, name_input, "Test User")
        time.sleep(0.5)
        driver.execute_script("arguments[0].blur()", name_input)
        time.sleep(0.5)
        print("[Python] Name filled via React setter", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[Python] Name React setter failed: {e}", file=sys.stderr)
    
    return False


def fill_age_field(driver):
    """Fill the birthday field - React Aria DatePicker."""
    # Strategy 1: Click the birthday field to reveal spinbuttons, then fill them
    try:
        # Find the birthday field container and click it
        birthday_containers = driver.find_elements(By.XPATH, "//*[contains(text(), 'Birthday') or contains(text(), 'Age') or contains(text(), 'birth')]")
        print(f"[Python] Found {len(birthday_containers)} birthday text elements", file=sys.stderr)
        
        if birthday_containers:
            # Use JavaScript to click the parent container of the birthday text
            driver.execute_script("""
                const birthdayText = Array.from(document.querySelectorAll('div, span')).find(el => 
                    el.textContent && el.textContent.includes('Birthday')
                );
                if (birthdayText) {
                    // Find the parent container that's clickable
                    const parent = birthdayText.closest('div[class*="field"], div[class*="DatePicker"]');
                    if (parent) {
                        parent.click();
                    } else {
                        // Try clicking the text element itself
                        birthdayText.click();
                    }
                }
            """)
            time.sleep(2)  # Wait for spinbuttons to appear
            
            # Now look for spinbuttons
            spinbuttons = driver.find_elements(By.CSS_SELECTOR, '[role="spinbutton"]')
            print(f"[Python] Found {len(spinbuttons)} spinbuttons after click", file=sys.stderr)
            
            if len(spinbuttons) >= 3:
                for i, spin in enumerate(spinbuttons):
                    aria_label = spin.get_attribute('aria-label') or ''
                    val = spin.get_attribute('value') or spin.text or ''
                    print(f"[Python] Spinbutton {i}: aria-label='{aria_label}', value='{val}'", file=sys.stderr)
                
                # Click and set each spinbutton
                # Month
                spinbuttons[0].click()
                time.sleep(0.3)
                spinbuttons[0].send_keys(Keys.CONTROL + 'a')
                time.sleep(0.2)
                spinbuttons[0].send_keys("1")
                time.sleep(0.3)
                
                # Day
                spinbuttons[1].click()
                time.sleep(0.3)
                spinbuttons[1].send_keys(Keys.CONTROL + 'a')
                time.sleep(0.2)
                spinbuttons[1].send_keys("15")
                time.sleep(0.3)
                
                # Year
                spinbuttons[2].click()
                time.sleep(0.3)
                spinbuttons[2].send_keys(Keys.CONTROL + 'a')
                time.sleep(0.2)
                spinbuttons[2].send_keys("1990")
                time.sleep(0.5)
                
                # Blur to trigger validation
                driver.execute_script("arguments[0].blur()", spinbuttons[2])
                time.sleep(1)
                
                print("[Python] Birthday set via spinbuttons", file=sys.stderr)
                
                # Verify
                verify = driver.execute_script("""
                    const input = document.querySelector('input[name="birthday"]');
                    return input ? input.value : 'NOT FOUND';
                """)
                print(f"[Python] Birthday verified: '{verify}'", file=sys.stderr)
                if verify == '1990-01-15':
                    return True
    except Exception as e:
        print(f"[Python] Spinbutton approach failed: {e}", file=sys.stderr)
    
    # Strategy 2: Directly set hidden input via React synthetic events
    print("[Python] Trying direct hidden input approach...", file=sys.stderr)
    try:
        result = driver.execute_script("""
            const input = document.querySelector('input[name="birthday"]');
            if (!input) return 'INPUT_NOT_FOUND';
            // Set value using native setter
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, '1990-01-15');
            // Dispatch React-compatible events
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            // Also try React's synthetic event system
            const nativeInputValueSetter2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter2.call(input, '1990-01-15');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            // Trigger blur to validate
            input.focus();
            input.blur();
            return input.value;
        """)
        print(f"[Python] Direct set result: {result}", file=sys.stderr)
        if result == '1990-01-15':
            return True
    except Exception as e:
        print(f"[Python] Direct hidden input failed: {e}", file=sys.stderr)
    
    # Strategy 3: Use Selenium's send_keys on the hidden input after clicking it
    print("[Python] Trying Selenium click and send_keys on hidden input...", file=sys.stderr)
    try:
        hidden_input = driver.find_element(By.CSS_SELECTOR, 'input[name="birthday"]')
        # Click to focus
        hidden_input.click()
        time.sleep(0.5)
        # Clear and type
        hidden_input.send_keys(Keys.CONTROL + 'a')
        time.sleep(0.2)
        hidden_input.send_keys(Keys.DELETE)
        time.sleep(0.2)
        hidden_input.send_keys("1990-01-15")
        time.sleep(0.5)
        hidden_input.send_keys(Keys.TAB)  # blur
        time.sleep(1)
        # Verify
        val = driver.execute_script("return document.querySelector('input[name=\"birthday\"]').value;")
        print(f"[Python] Selenium set result: {val}", file=sys.stderr)
        if val == '1990-01-15':
            return True
    except Exception as e:
        print(f"[Python] Selenium approach failed: {e}", file=sys.stderr)
    
    return False


def fill_email_and_continue(sb, target_email):
    email_selectors = [
        'input[name="email"]',
        'input[type="email"]',
        'input[placeholder*="Email" i]',
        'input[aria-label*="Email" i]',
    ]
    
    for sel in email_selectors:
        try:
            sb.wait_for_element(sel, timeout=3)
            sb.type(sel, target_email)
            print(f"[Python] Filled email: {sel}", file=sys.stderr)
            time.sleep(1)
            
            try:
                sb.click('button[type="submit"]', timeout=3)
            except:
                sb.click('button:has-text("Continue")', timeout=3)
            
            time.sleep(5)
            return True
        except:
            continue
    
    return False


def wait_for_page_load(sb, timeout=10):
    """Wait for the page to be fully loaded and React to be ready."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            # Check if React root is rendered
            has_content = sb.driver.execute_script("""
                return document.body.innerText.trim().length > 0;
            """)
            if has_content:
                return True
        except:
            pass
        time.sleep(0.5)
    return False


def main():
    parser = argparse.ArgumentParser(description='Browser automation to bypass Cloudflare Turnstile')
    parser.add_argument('target_email', help='Target email for OpenAI account')
    parser.add_argument('gmail_addr', help='Gmail address for verification codes')
    parser.add_argument('gmail_password', help='Gmail password or app password')
    parser.add_argument('--headless', action='store_true', help='Run in headless mode')
    parser.add_argument('--code-challenge', default='HWWEa6UoGkRUo5Tjmf8pAWugjvFUYF7ECOdQtWifL9w',
                        help='PKCE code challenge')
    parser.add_argument('--state', default='xLYfBh7SR1RGkISdRPBmPpoDaY_x6eOstwruTRRT98w',
                        help='OAuth state parameter')
    args = parser.parse_args()
    
    target_email = args.target_email
    gmail_addr = args.gmail_addr
    gmail_password = args.gmail_password
    headless = args.headless
    code_challenge = args.code_challenge
    state = args.state
    
    result = {"success": False, "error": None, "tokens": None, "password": None}
    
    try:
        print(f"[Python] Starting for {target_email}", file=sys.stderr)
        
        with SB(uc=True, headless=headless, xvfb=headless) as sb:
            driver = sb.driver
            
            # Step 1: Navigate to OpenAI auth
            print("[Python] Navigating to auth.openai.com...", file=sys.stderr)
            driver.uc_open_with_reconnect("https://auth.openai.com/log-in", reconnect_time=8)
            time.sleep(5)
            
            # Handle Turnstile
            try:
                sb.uc_gui_click_captcha()
                print("[Python] Clicked Turnstile", file=sys.stderr)
                time.sleep(8)
            except:
                pass
            
            sb.save_screenshot("debug/step1.png")
            print(f"[Python] URL: {driver.current_url}", file=sys.stderr)
            print(f"[Python] Title: {sb.get_title()}", file=sys.stderr)
            
            # Handle "Your session has ended" page
            if try_click(sb, ['a:contains("Log in")', 'button:contains("Log in")'], timeout=3):
                print("[Python] Clicked Log in on session ended page", file=sys.stderr)
                time.sleep(5)
                sb.save_screenshot("debug/step1b.png")
            
            # Step 2: Fill email and continue
            print("[Python] Filling email...", file=sys.stderr)
            if not fill_email_and_continue(sb, target_email):
                result["error"] = "Could not fill email"
                print(json.dumps(result))
                sys.exit(1)
            
            sb.save_screenshot("debug/step2.png")
            print(f"[Python] After email: {driver.current_url}", file=sys.stderr)
            
            # Step 3: Handle Turnstile
            try:
                sb.uc_gui_click_captcha()
                time.sleep(5)
            except:
                pass
            
            # Step 4: Check page state
            current_url = driver.current_url
            sb.save_screenshot("debug/step3.png")
            
            # Determine if we're on login page or create account page
            page_type = detect_existing_account(driver)
            if page_type == 'login':
                print("[Python] Account exists, proceeding to login...", file=sys.stderr)
                # We'll need to handle login later; for now, skip to password entry
                # (password entry will be handled in step 5)
                pass
            elif page_type == 'create':
                print("[Python] New account, proceeding to create...", file=sys.stderr)
                # Already on create page, continue
                pass
            else:
                # Fallback to URL detection
                if "password" in current_url or "log-in" in current_url:
                    print("[Python] On login/password page, clicking Sign up...", file=sys.stderr)
                    if try_click(sb, ['a:contains("Sign up")', 'button:contains("Sign up")'], timeout=3):
                        time.sleep(5)
                        sb.save_screenshot("debug/step4_signup.png")
                        print(f"[Python] After signup click: {driver.current_url}", file=sys.stderr)
                        
                        if "create-account" in driver.current_url:
                            print("[Python] On create-account page, filling email...", file=sys.stderr)
                            fill_email_and_continue(sb, target_email)
                            time.sleep(5)
                            sb.save_screenshot("debug/step4b_after_email.png")
            
            # Step 5: Handle password setup
            current_url = driver.current_url
            try:
                password_input = sb.find_element('input[type="password"]', timeout=5)
                password = generate_password()
                print(f"[Python] Setting password...", file=sys.stderr)
                sb.type('input[type="password"]', password)
                time.sleep(1)
                
                # Try to find and fill confirm password field
                confirm_selectors = ['input[name="confirmPassword"]', 'input[name="confirm_password"]', 'input[placeholder*="Confirm"]', 'input[aria-label*="Confirm"]']
                for sel in confirm_selectors:
                    try:
                        confirm_input = driver.find_element(By.CSS_SELECTOR, sel)
                        confirm_input.send_keys(Keys.CONTROL + 'a')
                        confirm_input.send_keys(Keys.DELETE)
                        confirm_input.send_keys(password)
                        print(f"[Python] Filled confirm password via {sel}", file=sys.stderr)
                        break
                    except:
                        continue
                
                try_click(sb, ['button[type="submit"]', 'button:contains("Continue")'])
                time.sleep(5)
                print(f"[Python] Storing password: {password[:4]}****", file=sys.stderr)
                result["password"] = password
                sb.save_screenshot("debug/step5_password.png")
                print(f"[Python] After password: {driver.current_url}", file=sys.stderr)
            except:
                print("[Python] No password input", file=sys.stderr)
            
            # Store password for later login if not already set
            if not result.get("password"):
                result["password"] = generate_password()
            
            # Step 6: Handle OTP verification
            try:
                sb.find_element('input[name="code"], input[inputmode="numeric"], input[autocomplete="one-time-code"]', timeout=10)
                print("[Python] Code input found, waiting for OTP...", file=sys.stderr)
                
                # Wait for OTP from Gmail (start fetching early)
                otp = get_verification_code(gmail_addr, gmail_password, target_email, timeout=120)
                if not otp:
                    result["error"] = "No verification code received"
                    print(json.dumps(result))
                    sys.exit(1)
                
                print(f"[Python] Got OTP: {otp}", file=sys.stderr)
                sb.type('input[name="code"], input[inputmode="numeric"], input[autocomplete="one-time-code"]', otp)
                time.sleep(1)
                
                try_click(sb, ['button[type="submit"]', 'button:contains("Continue")', 'button:contains("Verify")'])
                time.sleep(5)
                sb.save_screenshot("debug/step6_otp.png")
                print(f"[Python] After OTP: {driver.current_url}", file=sys.stderr)
            except:
                print("[Python] No OTP input", file=sys.stderr)
            
            # Step 7: Handle about-you page
            time.sleep(3)
            sb.save_screenshot("debug/step7_about_you.png")
            print(f"[Python] About-you page URL: {driver.current_url}", file=sys.stderr)
            # Debug: print birthday field HTML
            birthday_html = driver.execute_script("""
                const input = document.querySelector('input[name=\"birthday\"]');
                if (input) {
                    return input.outerHTML + ' | parent: ' + input.parentElement.outerHTML.substring(0, 500);
                }
                return 'NOT FOUND';
            """)
            print(f"[Python] Birthday HTML: {birthday_html}", file=sys.stderr)
            
            # Fill name
            print("[Python] Filling name...", file=sys.stderr)
            fill_name_field(driver)
            time.sleep(1)
            
            # Fill age
            print("[Python] Filling age...", file=sys.stderr)
            fill_age_field(driver)
            time.sleep(1)
            
            sb.save_screenshot("debug/step7b_filled.png")
            
            # Check if button is now enabled
            print("[Python] Checking Finish button state...", file=sys.stderr)
            try:
                finish_btn = driver.find_element(By.XPATH, "//button[contains(text(), 'Finish')]")
                is_disabled = finish_btn.get_attribute('disabled')
                btn_text = finish_btn.text
                print(f"[Python] Finish button: text='{btn_text}', disabled={is_disabled}", file=sys.stderr)
                
                # Check the birthday hidden input value
                birthday_val = driver.execute_script("""
                    const input = document.querySelector('input[name="birthday"]');
                    return input ? input.value : 'NOT FOUND';
                """)
                print(f"[Python] Birthday input value: '{birthday_val}'", file=sys.stderr)
                
                # Check the name input value
                name_val = driver.execute_script("""
                    const input = document.querySelector('input[name="name"]');
                    return input ? input.value : 'NOT FOUND';
                """)
                print(f"[Python] Name input value: '{name_val}'", file=sys.stderr)
            except Exception as e:
                print(f"[Python] Could not check button state: {e}", file=sys.stderr)
            
            # Save page source before clicking Finish
            try:
                with open(f"debug/about_you_before_{int(time.time())}.html", "w", encoding="utf-8") as f:
                    f.write(driver.page_source)
                print(f"[Python] Saved page source before Finish", file=sys.stderr)
            except Exception as e:
                print(f"[Python] Failed to save page source: {e}", file=sys.stderr)
            
            # Click Finish using multiple approaches
            print("[Python] Clicking Finish creating account...", file=sys.stderr)
            
            # Approach 1: Direct click
            clicked = try_click(sb, ['button[type="submit"]', 'button:contains("Finish")'])
            
            if not clicked:
                # Approach 2: JS click
                print("[Python] Trying JS click on finish button...", file=sys.stderr)
                try:
                    driver.execute_script("""
                        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Finish'));
                        if (btn) {
                            btn.click();
                            console.log('JS clicked finish button');
                        } else {
                            console.log('No finish button found');
                        }
                    """)
                except Exception as e:
                    print(f"[Python] JS click failed: {e}", file=sys.stderr)
            
            time.sleep(10)
            sb.save_screenshot("debug/step7c_after_finish.png")
            print(f"[Python] After finish: {driver.current_url}", file=sys.stderr)
            
            # Debug: dump page structure
            debug_html = driver.execute_script("""
                const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
                const buttons = Array.from(document.querySelectorAll('button'));
                return {
                    inputs: inputs.map(i => ({type: i.type, name: i.name, value: i.value, id: i.id, placeholder: i.placeholder, required: i.required})),
                    buttons: buttons.map(b => ({text: b.textContent.trim(), disabled: b.disabled, type: b.type}))
                };
            """)
            print(f"[Python] Page debug: {json.dumps(debug_html, indent=2)}", file=sys.stderr)
            
            # If still on about-you, check for validation errors
            if "about-you" in driver.current_url:
                print("[Python] Still on about-you, checking for errors...", file=sys.stderr)
                try:
                    error_text = driver.execute_script("""
                        const errors = document.querySelectorAll('[role="alert"], [class*="error"], [class*="invalid"]');
                        return Array.from(errors).map(e => e.textContent).join(' | ');
                    """)
                    print(f"[Python] Validation errors: '{error_text}'", file=sys.stderr)
                    # Save page source for debugging
                    try:
                        with open("debug/about_you_page.html", "w", encoding="utf-8") as f:
                            f.write(driver.page_source)
                        print("[Python] Saved page source to debug/about_you_page.html", file=sys.stderr)
                    except Exception as e:
                        print(f"[Python] Failed to save page source: {e}", file=sys.stderr)
                except:
                    pass
                
                # Try clicking again with a longer wait
                print("[Python] Retrying finish button click...", file=sys.stderr)
                time.sleep(3)
                try:
                    driver.execute_script("""
                        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Finish'));
                        if (btn) {
                            btn.scrollIntoView();
                            btn.click();
                        }
                    """)
                    time.sleep(10)
                    sb.save_screenshot("debug/step7d_retry.png")
                    print(f"[Python] After retry: {driver.current_url}", file=sys.stderr)
                except Exception as e:
                    print(f"[Python] Retry failed: {e}", file=sys.stderr)
            
            # After account creation, the session should already be authenticated
            time.sleep(5)
            final_url = driver.current_url
            
            # If we're on a login page, the session wasn't maintained - try to log in
            if "log-in" in final_url or "login" in final_url:
                print("[Python] Session not maintained, logging in...", file=sys.stderr)
                
                # Check if we are on password page (password input already present)
                password_input = driver.find_elements(By.CSS_SELECTOR, 'input[type="password"]')
                if password_input:
                    print("[Python] Password input already present, skipping email step", file=sys.stderr)
                else:
                    # Enter email
                    fill_email_and_continue(sb, target_email)
                    time.sleep(5)
                    sb.save_screenshot("debug/step8_login_email.png")
                    
                    # Handle Turnstile if needed
                    try:
                        sb.uc_gui_click_captcha()
                        time.sleep(5)
                    except:
                        pass
                
                # Enter password - use JavaScript to set value directly
                try:
                    password = result.get("password") or "TempPass123!"
                    print(f"[Python] Using password: {password[:4]}****", file=sys.stderr)
                    print(f"[Python] Entering password...", file=sys.stderr)
                    
                    # Use JavaScript to set the password value
                    driver.execute_script("""
                        const passwordInput = document.querySelector('input[type="password"]');
                        if (passwordInput) {
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            nativeInputValueSetter.call(passwordInput, arguments[0]);
                            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                            passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    """, password)
                    time.sleep(1)
                    
                    # Verify password was entered
                    current_value = driver.execute_script("""
                        const passwordInput = document.querySelector('input[type="password"]');
                        return passwordInput ? passwordInput.value : '';
                    """)
                    print(f"[Python] Password field has {len(current_value) if current_value else 0} chars", file=sys.stderr)
                    
                    # Click Continue button
                    print("[Python] Looking for Continue button...", file=sys.stderr)
                    buttons = driver.find_elements(By.TAG_NAME, 'button')
                    for btn in buttons:
                        text = btn.text.strip()
                        disabled = btn.get_attribute('disabled')
                        print(f"[Python] Button: '{text}' disabled={disabled}", file=sys.stderr)
                    
                    clicked = try_click(sb, ['button[type="submit"]', 'button:contains("Continue")'])
                    print(f"[Python] Click result: {clicked}", file=sys.stderr)
                    time.sleep(10)
                    sb.save_screenshot("debug/step8b_after_password.png")
                    print(f"[Python] After login: {driver.current_url}", file=sys.stderr)
                    
                    # Check for error messages
                    error_text = driver.execute_script("""
                        const errors = document.querySelectorAll('[role="alert"], [class*="error"], [class*="invalid"]');
                        return Array.from(errors).map(e => e.textContent).join(' | ');
                    """)
                    if error_text:
                        print(f"[Python] Error messages: '{error_text}'", file=sys.stderr)
                except Exception as e:
                    print(f"[Python] Password entry failed: {e}", file=sys.stderr)
                
                # Handle Turnstile if needed
                try:
                    sb.uc_gui_click_captcha()
                    time.sleep(5)
                except:
                    pass
            
            # Navigate to OAuth authorize URL to get tokens
            print("[Python] Navigating to OAuth authorize URL...", file=sys.stderr)
            auth_url = (f"https://auth.openai.com/oauth/authorize?"
                        f"client_id=app_EMoamEEZ73f0CkXaXp7hrann"
                        f"&redirect_uri=http://localhost:1455/auth/callback"
                        f"&response_type=code"
                        f"&scope=openid+profile+email+offline_access+api.connectors.read+api.connectors.invoke"
                        f"&code_challenge={code_challenge}"
                        f"&code_challenge_method=S256"
                        f"&id_token_add_organizations=true"
                        f"&state={state}")
            
            try:
                driver.get(auth_url)
                time.sleep(10)
                sb.save_screenshot("debug/step9_oauth.png")
                print(f"[Python] After OAuth nav: {driver.current_url}", file=sys.stderr)
                
                # Check if we got redirected to the callback
                if "localhost" in driver.current_url or "127.0.0.1" in driver.current_url:
                    print("[Python] Got OAuth callback URL!", file=sys.stderr)
                    from urllib.parse import urlparse, parse_qs
                    parsed = urlparse(driver.current_url)
                    params = parse_qs(parsed.query)
                    if "code" in params:
                        result["oauth_code"] = params["code"][0]
                        print(f"[Python] OAuth code: {result['oauth_code'][:20]}...", file=sys.stderr)
                elif "consent" in driver.current_url or "authorize" in driver.current_url:
                    # Need to click consent/allow
                    print("[Python] On consent page, clicking allow...", file=sys.stderr)
                    try:
                        try_click(sb, ['button:contains("Allow")', 'button:contains("Continue")', 'button:contains("Authorize")', 'button:contains("Accept")'])
                        time.sleep(10)
                        sb.save_screenshot("debug/step9b_after_consent.png")
                        print(f"[Python] After consent: {driver.current_url}", file=sys.stderr)
                        
                        if "localhost" in driver.current_url or "127.0.0.1" in driver.current_url:
                            from urllib.parse import urlparse, parse_qs
                            parsed = urlparse(driver.current_url)
                            params = parse_qs(parsed.query)
                            if "code" in params:
                                result["oauth_code"] = params["code"][0]
                                print(f"[Python] OAuth code: {result['oauth_code'][:20]}...", file=sys.stderr)
                    except Exception as e:
                        print(f"[Python] Consent click failed: {e}", file=sys.stderr)
            except Exception as e:
                print(f"[Python] OAuth nav failed: {e}", file=sys.stderr)
            
            final_url = driver.current_url
            print(f"[Python] Final URL: {final_url}", file=sys.stderr)
            sb.save_screenshot("debug/final.png")
            
            cookies = driver.get_cookies()
            
            if ("chatgpt.com" in final_url or "auth.openai.com" in final_url) and "/error" not in final_url:
                result["success"] = True
                result["cookies"] = cookies
                result["url"] = final_url
            else:
                result["error"] = f"Final URL indicates failure: {final_url}"
        
        print(json.dumps(result))
        
    except Exception as e:
        result["error"] = str(e)
        print(json.dumps(result))
        sys.exit(1)


if __name__ == "__main__":
    main()
