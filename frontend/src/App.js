import React, { useEffect, useState } from 'react';
import axios from 'axios';

function App() {
    const [consultations, setConsultations] = useState([]);

    useEffect(() => {
        fetchConsultations();
    }, []);

    const fetchConsultations = async () => {
        const response = await axios.get('/api/consultations');
        setConsultations(response.data);
    };

    const updateStatus = async (id, status) => {
        await axios.post(`/api/consultations/${id}/status`, { status });
        fetchConsultations();
    };

    return (
        <div className="App">
            <h1>Rental Equipment Consultation Queue</h1>
            <table>
                <thead>
                    <tr>
                        <th>Customer Name</th>
                        <th>Contact Details</th>
                        <th>Waiver Completion Time</th>
                        <th>Form Link</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {consultations.map(consultation => (
                        <tr key={consultation._id}>
                            <td>{consultation.customerName}</td>
                            <td>{consultation.contactDetails}</td>
                            <td>{new Date(consultation.waiverCompletionTime).toLocaleString()}</td>
                            <td><a href={consultation.formLink} target="_blank" rel="noopener noreferrer">Open Form</a></td>
                            <td>{consultation.status}</td>
                            <td>
                                <button onClick={() => updateStatus(consultation._id, 'Completed')}>Complete</button>
                                <button onClick={() => updateStatus(consultation._id, 'Pending')}>Pending</button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default App;
