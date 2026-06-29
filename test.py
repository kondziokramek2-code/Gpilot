import math
import threading
import time


class MockAircraftRequests:
    """Udaje AircraftRequests bez uruchomionego MSFS."""

    def get(self, variable_name):
        values = {
            # EPWR RWY 29 — punkt testowy na pasie
            "PLANE_LATITUDE": 51.0986,
            "PLANE_LONGITUDE": 16.9008,

            # wysokość MSL w stopach
            "PLANE_ALTITUDE": 404.0,

            # Twój kod niżej robi math.degrees(), więc tutaj muszą być radiany
            "PLANE_HEADING_DEGREES_TRUE": math.radians(295.0),

            # COM1 MHz
            "COM_ACTIVE_FREQUENCY:1": 118.000,

            # BCO16: 0x7000 po formatowaniu :04x daje "7000"
            "TRANSPONDER_CODE:1": 0x7000,
            "TRANSPONDER_CODE": 0x7000,
        }

        return values.get(variable_name)


class MSFSConnector:
    def __init__(self, mock_mode=True):
        self.sm = None
        self.aq = None
        self.connected = False
        self.mock_mode = mock_mode

        self._emit_thread = None
        self._emit_stop = threading.Event()

    def connect(self):
        """Łączy z MSFS albo uruchamia dane testowe."""
        if self.mock_mode:
            self.aq = MockAircraftRequests()
            self.connected = True
            return True, "Uruchomiono mock MSFS: EPWR RWY 29, HDG 295, ALT 404 ft."

        try:
            # Import dopiero tutaj, żeby mock działał nawet bez biblioteki SimConnect
            from SimConnect import SimConnect, AircraftRequests

            self.sm = SimConnect()
            self.aq = AircraftRequests(self.sm, _time=2000)
            self.connected = True
            return True, "Połączono z MSFS 2020."

        except Exception as e:
            self.connected = False
            return False, f"Błąd połączenia: {str(e)}"

    def disconnect(self):
        self.stop_emitting()

        if self.sm and hasattr(self.sm, "quit"):
            self.sm.quit()

        self.sm = None
        self.aq = None
        self.connected = False

    def get_flight_data(self):
        """Zwraca dane testowe albo prawdziwe dane z MSFS."""
        if not self.connected or not self.aq:
            return None

        try:
            lat = self.aq.get("PLANE_LATITUDE")
            lon = self.aq.get("PLANE_LONGITUDE")
            alt = self.aq.get("PLANE_ALTITUDE")
            heading = self.aq.get("PLANE_HEADING_DEGREES_TRUE")
            com1 = self.aq.get("COM_ACTIVE_FREQUENCY:1")

            transponder_val = self.aq.get("TRANSPONDER_CODE:1")
            if transponder_val is None:
                transponder_val = self.aq.get("TRANSPONDER_CODE")

            try:
                squawk = f"{int(transponder_val):04x}" if transponder_val is not None else "7000"
            except Exception:
                squawk = "7000"

            if lat is None or lon is None:
                return None

            return {
                "lat": float(lat),
                "lon": float(lon),
                "alt": float(alt) if alt is not None else 0.0,
                "heading": math.degrees(float(heading)) if heading is not None else 0.0,
                "com1_freq": float(com1) if com1 is not None else 118.0,
                "transponder": squawk
            }

        except Exception as e:
            print(f"Błąd podczas pobierania danych: {e}")
            self.connected = False
            return None

    def start_emitting(self, callback, hz=20):
        """
        Aktywnie wysyła dane do callbacka, np. 20 razy na sekundę.
        callback dostaje słownik z get_flight_data().
        """
        if not self.connected:
            raise RuntimeError("Najpierw wywołaj connect().")

        self.stop_emitting()
        self._emit_stop.clear()

        def loop():
            interval = 1 / max(hz, 1)

            while not self._emit_stop.is_set():
                data = self.get_flight_data()

                if data is not None:
                    try:
                        callback(data)
                    except Exception as e:
                        print(f"Błąd callbacka: {e}")

                self._emit_stop.wait(interval)

        self._emit_thread = threading.Thread(target=loop, daemon=True)
        self._emit_thread.start()

    def stop_emitting(self):
        self._emit_stop.set()

        if self._emit_thread and self._emit_thread.is_alive():
            self._emit_thread.join(timeout=1)

        self._emit_thread = None