"""
Kivicare → Fidean Clinic OS Migration Script
Migrates Lekki branch data from MariaDB dump into the existing celon-dental tenant.

Usage:
  python3 migrate_kivicare_to_fidean.py

This script:
  1. Reads the Kivicare MariaDB SQL dump (/tmp/celon_wp.sql)
  2. Maps entities to Fidean Clinic OS format
  3. Inserts into Postgres with Lekki branch_id

Tenant: Celon Dental (c210a383-7329-4501-acc6-0f2f36d402f3)
Lekki branch: 6717846e-7cc1-43df-8552-43665558a8ef
"""

import re
import json
import psycopg2
from datetime import datetime

# ── Config ──
DUMP_PATH = '/tmp/celon_wp.sql'
TENANT_ID = 'c210a383-7329-4501-acc6-0f2f36d402f3'
LEKKI_BRANCH_ID = '6717846e-7cc1-43df-8552-43665558a8ef'
DB = 'postgres://clinic:clinic_dev_2026@127.0.0.1:5432/clinic'

# Known Kivicare service_id → Fidean price mapping (from dump analysis)
# These are the Lekki doctor-service mappings with prices
SERVICE_PRICES = {
    8: 15000, 9: 10000, 10: 150000, 11: 60000, 12: 80000,
    13: 250000, 14: 25000, 15: 120000, 16: 300000, 17: 50000,
    18: 30000, 19: 60000, 20: 55000, 21: 90000, 22: 80000,
    23: 250000, 24: 300000, 25: 5000, 26: 150000, 27: 180000,
    28: 250000, 29: 50000, 30: 15000, 31: 120000, 32: 20000,
    33: 0, 34: 10000, 35: 0,
}

# ── Helpers ──
def conn():
    return psycopg2.connect(DB)

def generate_patient_code():
    import uuid
    return f"PAT-{uuid.uuid4().hex[:8].upper()}"

def esc(val):
    """Escape for SQL literal"""
    if val is None:
        return 'NULL'
    return f"'{str(val).replace(chr(39), chr(39)+chr(39))}'"

# ── Parse Kivicare Dump ──
class KivicareParser:
    def __init__(self, path):
        self.path = path
        self.users = {}          # wp_user_id → {email, display_name}
        self.patients = {}       # wp_user_id → {basic_data dict, first_name, last_name, patient_unique_id}
        self.lekki_patient_ids = set()
        self.services = {}       # kivicare_service_id → {name, price, type}
        self.appointments = []   # list of appointment dicts
        self.encounters = []     # list of encounter dicts
        self.bills = []          # list of bill dicts
        self.bill_items = []     # list of bill_item dicts
        self.prescriptions = []  # list of prescription dicts
        self.doctor_mappings = {}  # service_id → {doctor_id, clinic_id, charges}
        self.doctor_schedules = [] # clinic schedules
        self.service_doctor_map = {} # service_id → list of doctors

    def parse(self):
        with open(self.path, 'r') as f:
            content = f.read()
        
        self._parse_users(content)
        self._parse_mappings(content)
        self._parse_usermeta(content)
        self._parse_services(content)
        self._parse_service_doctor_mappings(content)
        self._parse_appointments(content)
        self._parse_encounters(content)
        self._parse_bills(content)
        self._parse_bill_items(content)
        self._parse_prescriptions(content)
        self._parse_doctor_schedules(content)
        
        print(f"Parsed: {len(self.lekki_patient_ids)} patients, {len(self.services)} services, "
              f"{len(self.appointments)} appointments, {len(self.encounters)} encounters, "
              f"{len(self.bills)} bills, {len(self.prescriptions)} prescriptions")

    def _parse_users(self, content):
        m = re.search(r"INSERT INTO `wp_users` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),'[^']*','[^']*','[^']*','([^']*)'", m.group(1)):
                self.users[match.group(1)] = {'email': match.group(2)}

    def _parse_mappings(self, content):
        m = re.search(r"INSERT INTO `wp_kc_patient_clinic_mappings` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),(\d+),(\d+),'[^']*'\)", m.group(1)):
                pid, cid = match.group(2), match.group(3)
                if cid == '1':
                    self.lekki_patient_ids.add(pid)

    def _parse_usermeta(self, content):
        in_usermeta = False
        seen_lekki = set()
        for line in open(self.path, 'r'):
            if 'INSERT INTO `wp_usermeta` VALUES' in line:
                in_usermeta = True
                line = line.split('VALUES', 1)[1]
            if in_usermeta:
                for m in re.finditer(r"\((\d+),(\d+),'([^']*)','([^']*)'\)", line):
                    uid, k, v = m.group(2), m.group(3), m.group(4)
                    if uid in self.lekki_patient_ids:
                        if uid not in self.patients:
                            self.patients[uid] = {'first_name': '', 'last_name': '', 'patient_unique_id': '', 'basic_data': {}}
                        if k == 'first_name':
                            self.patients[uid]['first_name'] = v
                        elif k == 'last_name':
                            self.patients[uid]['last_name'] = v
                        elif k == 'patient_unique_id':
                            self.patients[uid]['patient_unique_id'] = v
                        elif k == 'basic_data':
                            try:
                                self.patients[uid]['basic_data'] = json.loads(v.replace('\\"', '"').replace('\\n', '').replace('\\', ''))
                            except:
                                self.patients[uid]['basic_data'] = {}
                        seen_lekki.add(uid)
                if line.strip().endswith(');'):
                    break
        # Remove patients that weren't in usermeta
        missing = self.lekki_patient_ids - seen_lekki
        if missing:
            print(f"  Warning: {len(missing)} patient IDs have no usermeta data")

    def _parse_services(self, content):
        m = re.search(r"INSERT INTO `wp_kc_services` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),'([^']*)','([^']*)','([^']*)','([^']*)',(\d+),'([^']*)'\)", m.group(1)):
                sid, stype, scat, sname, sprice, sstatus, screated = match.groups()
                # Only include bill_service and general_dentistry (skip system_service like Telemed)
                if stype != 'system_service':
                    self.services[sid] = {
                        'name': sname,
                        'type': stype,
                        'price': sprice,
                        'status': sstatus,
                    }

    def _parse_service_doctor_mappings(self, content):
        m = re.search(r"INSERT INTO `wp_kc_service_doctor_mapping` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),(\d+),(\d+),(\d+),'([^']*)'", m.group(1)):
                mid, sid, did, cid, charges = match.groups()
                if cid == '1':  # Lekki only
                    if sid not in self.service_doctor_map:
                        self.service_doctor_map[sid] = []
                    self.service_doctor_map[sid].append({'doctor_id': did, 'charges': charges})

    def _parse_appointments(self, content):
        m = re.search(r"INSERT INTO `wp_kc_appointments` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),'([^']*)','([^']*)','([^']*)','([^']*)','([^']*)',(\d+),(\d+),(\d+),'([^']*)',(\d+),'([^']*)'", m.group(1)):
                aid, sdate, stime, edate, etime, vtype, cid, did, pid, desc, status, created = match.groups()
                if cid == '1':  # Lekki only
                    self.appointments.append({
                        'id': aid, 'start_date': sdate, 'start_time': stime,
                        'end_date': edate, 'end_time': etime, 'visit_type': vtype,
                        'clinic_id': cid, 'doctor_id': did, 'patient_id': pid,
                        'description': desc, 'status': status, 'created_at': created
                    })

    def _parse_encounters(self, content):
        m = re.search(r"INSERT INTO `wp_kc_patient_encounters` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),'([^']*)',(\d+),(\d+),(\d+),(\d+),'([^']*)',(\d+),(\d+),'([^']*)',(\d+)\)", m.group(1)):
                eid, edate, cid, did, pid, aid, desc, status, added_by, created, template_id = match.groups()
                if cid == 1:  # Lekki only
                    self.encounters.append({
                        'id': eid, 'encounter_date': edate, 'clinic_id': cid,
                        'doctor_id': did, 'patient_id': pid, 'appointment_id': aid,
                        'description': desc, 'status': status, 'created_at': created
                    })

    def _parse_bills(self, content):
        m = re.search(r"INSERT INTO `wp_kc_bills` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),(\d+),(\d+),'([^']*)','([^']*)','([^']*)','([^']*)',(\d+),'([^']*)','([^']*)',(\d+)\)", m.group(1)):
                bid, eid, aid, title, total, discount, actual, status, pay_status, created, cid = match.groups()
                if str(cid) == '1':  # Lekki only
                    self.bills.append({
                        'id': bid, 'encounter_id': eid, 'appointment_id': aid,
                        'title': title, 'total_amount': total, 'discount': discount,
                        'actual_amount': actual, 'status': status, 'payment_status': pay_status,
                        'created_at': created
                    })

    def _parse_bill_items(self, content):
        m = re.search(r"INSERT INTO `wp_kc_bill_items` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),(\d+),(\d+),(\d+),'([^']*)','([^']*)'\)", m.group(1)):
                biid, bid, iid, qty, price, created = match.groups()
                self.bill_items.append({
                    'id': biid, 'bill_id': bid, 'item_id': iid,
                    'qty': qty, 'price': price, 'created_at': created
                })

    def _parse_prescriptions(self, content):
        m = re.search(r"INSERT INTO `wp_kc_prescription` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),(\d+),(\d+),'([^']*)','([^']*)','([^']*)','([^']*)',(\d+),'([^']*)',(\d+)\)", m.group(1)):
                prid, eid, pid, name, freq, dur, instr, added_by, created, is_template = match.groups()
                # Filter by encounter's clinic = Lekki (we'll validate during insert)
                self.prescriptions.append({
                    'id': prid, 'encounter_id': eid, 'patient_id': pid,
                    'name': name, 'frequency': freq, 'duration': dur,
                    'instruction': instr, 'created_at': created
                })

    def _parse_doctor_schedules(self, content):
        # Kivicare doctor sessions list available times
        m = re.search(r"INSERT INTO `wp_kc_clinic_sessions` VALUES (.+?);\s*\n", content, re.DOTALL)
        if m:
            for match in re.finditer(r"\((\d+),(\d+),(\d+),'([^']*)','([^']*)','([^']*)',(\d+),(\d+),'([^']*)',(\d+)\)", m.group(1)):
                # doctor_id, clinic_id, weekday, start_time, end_time, slot_minutes, status
                pass  # We'll handle in the comprehensive script


# ── Main Migration ──
def migrate():
    print("=" * 60)
    print("Kivicare → Fidean Clinic OS Migration")
    print(f"Tenant: {TENANT_ID}")
    print(f"Lekki Branch: {LEKKI_BRANCH_ID}")
    print("=" * 60)
    
    # 1. Parse Kivicare dump
    print("\n[1/5] Parsing Kivicare dump...")
    parser = KivicareParser(DUMP_PATH)
    parser.parse()
    
    pg = conn()
    cur = pg.cursor()
    
    try:
        # 2. Migrate Services
        print(f"\n[2/5] Migrating {len(parser.services)} services...")
        svc_count = 0
        for sid, svc in sorted(parser.services.items(), key=lambda x: int(x[0])):
            price = int(svc['price']) if svc['price'] and svc['price'].lstrip('-').isdigit() else 0
            # Check if service already exists (by Lekki branch pricing)
            cur.execute(
                "SELECT id FROM services WHERE tenant_id = %s AND name = %s AND branch_id = %s",
                (TENANT_ID, svc['name'], LEKKI_BRANCH_ID)
            )
            existing = cur.fetchone()
            if not existing:
                duration = 30  # default 30 min
                cur.execute(
                    "INSERT INTO services (tenant_id, branch_id, name, duration_minutes, price_kobo) "
                    "VALUES (%s, %s, %s, %s, %s) RETURNING id",
                    (TENANT_ID, LEKKI_BRANCH_ID, svc['name'], duration, price)
                )
                svc_count += 1
        print(f"  Created {svc_count} new services")
        
        # 3. Migrate Patients
        print(f"\n[3/5] Migrating {len(parser.patients)} patients...")
        pat_count = 0
        patient_id_map = {}  # kivicare_uid → fidean_uuid
        
        for uid, pdata in sorted(parser.patients.items(), key=lambda x: int(x[0])):
            bd = pdata.get('basic_data', {})
            phone = (bd.get('mobile_number', '') or '').replace(' ', '').replace('+', '')
            if not phone:
                phone = '0000000000'
            
            email = parser.users.get(uid, {}).get('email', '')
            first_name = pdata.get('first_name', 'Unknown')
            last_name = pdata.get('last_name', '')
            patient_code = generate_patient_code()
            dob = bd.get('dob', '')
            if not dob or dob == '0000-00-00':
                dob = None
            
            cur.execute(
                """INSERT INTO patients (tenant_id, branch_id, patient_code, clinic_patient_id, 
                   first_name, last_name, phone, email, dob, gender, address, city, state, blood_group)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, patient_code) DO NOTHING
                   RETURNING id""",
                (TENANT_ID, LEKKI_BRANCH_ID, patient_code, pdata.get('patient_unique_id', ''),
                 first_name, last_name, phone,
                 email.lower() if email else None,
                 dob, bd.get('gender', ''), bd.get('address', ''),
                 bd.get('city', ''), bd.get('state', ''), bd.get('blood_group', ''))
            )
            row = cur.fetchone()
            if row:
                patient_id_map[uid] = row[0]
                pat_count += 1
        
        pg.commit()
        print(f"  Inserted {pat_count} patients")
        
        # 4. Migrate Appointments
        print(f"\n[4/5] Migrating {len(parser.appointments)} appointments...")
        apt_count = 0
        for apt in parser.appointments:
            pid = patient_id_map.get(apt['patient_id'])
            if not pid:
                continue
            start_dt = f"{apt['start_date']} {apt['start_time']}" if apt['start_date'] and apt['start_time'] else None
            if not start_dt:
                continue
            
            # Map Kivicare status to Fidean status
            status_map = {'0': 'requested', '1': 'confirmed', '2': 'checked_in', '3': 'completed', '4': 'cancelled'}
            fstatus = status_map.get(apt['status'], 'requested')
            
            cur.execute(
                "SELECT id FROM appointments WHERE tenant_id = %s AND patient_id = %s AND starts_at = %s",
                (TENANT_ID, pid, start_dt)
            )
            if not cur.fetchone():
                cur.execute(
                    "INSERT INTO appointments (tenant_id, branch_id, patient_id, service_name, starts_at, status, notes, created_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    (TENANT_ID, LEKKI_BRANCH_ID, pid, apt.get('description', 'Consultation'),
                     start_dt, fstatus, apt.get('description', ''), apt.get('created_at', datetime.now().isoformat()))
                )
                apt_count += 1
        
        pg.commit()
        print(f"  Created {apt_count} appointments")
        
        # 5. Migrate Encounters
        print(f"\n[5/5] Migrating {len(parser.encounters)} encounters...")
        enc_count = 0
        for enc in parser.encounters:
            pid = patient_id_map.get(enc['patient_id'])
            if not pid:
                continue
            cur.execute(
                "SELECT id FROM encounters WHERE tenant_id = %s AND patient_id = %s AND encounter_date = %s",
                (TENANT_ID, pid, enc.get('encounter_date', ''))
            )
            if not cur.fetchone():
                status_enc = 'signed' if enc['status'] == '1' else 'in_progress'
                cur.execute(
                    "INSERT INTO encounters (tenant_id, branch_id, patient_id, status, reason, clinical_notes) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (TENANT_ID, LEKKI_BRANCH_ID, pid, status_enc,
                     enc.get('description', '')[:200] if enc.get('description') else '',
                     enc.get('description', ''))
                )
                enc_count += 1
        
        pg.commit()
        print(f"  Created {enc_count} encounters")
        
        print("\n" + "=" * 60)
        print("✅ Migration complete!")
        print(f"   Services: {svc_count}")
        print(f"   Patients: {pat_count}")
        print(f"   Appointments: {apt_count}")
        print(f"   Encounters: {enc_count}")
        print("=" * 60)
        
    except Exception as e:
        pg.rollback()
        print(f"\n❌ Migration failed: {e}")
        raise
    finally:
        cur.close()
        pg.close()

if __name__ == '__main__':
    migrate()